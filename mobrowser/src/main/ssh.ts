// Derived from: app/lib/ssh.ts

import * as russh from 'russh'
import * as fs from 'node:fs/promises'
import * as crypto from 'node:crypto'
import { createServer, Socket, Server } from 'node:net'
import * as keytar from 'keytar'
import type {
  SshConnectRequest,
  SshSessionEvent,
  SshHostKeyResponse,
  SshUsernameResponse,
  SshPasswordResponse,
  SshPassphraseResponse,
  SshKiResponse,
  SshSessionId,
  SshOpenShellRequest,
  SshShellWriteRequest,
  SshShellResizeRequest,
  SshShellEvent,
  SshSftpPathRequest,
  SshSftpOpenRequest,
  SshSftpHandleRequest,
  SshSftpReadRequest,
  SshSftpWriteRequest,
  SshSftpRenameRequest,
  SshSftpChmodRequest,
  SshSftpReaddirResult,
  SshSftpStatResult,
  SshSftpOpenResult,
  SshSftpReadResult,
  SshPortForwardRequest,
  SshJumpChannelRequest,
} from './gen/ssh'
import type { StringValue } from './gen/google/protobuf/wrappers'
import type { Empty } from './gen/google/protobuf/empty'
import type { SshService } from './gen/ipc_service'
import type { RequestContext, StreamContext } from '@mobrowser/api'

// ── AsyncQueue ────────────────────────────────────────────────────────────────

class AsyncQueue<T> {
  private buffer: T[] = []
  private resolver: ((value: IteratorResult<T>) => void) | null = null
  private closed = false

  push(value: T): void {
    if (this.closed) return
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r({ value: undefined as any, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        return new Promise(resolve => { this.resolver = resolve })
      },
    }
  }
}

// ── Event helpers ─────────────────────────────────────────────────────────────

function ev(type: string, fields: Partial<SshSessionEvent> = {}): SshSessionEvent {
  return {
    type,
    serviceMessageText: '',
    hostKeyChallenge: undefined,
    usernameChallenge: undefined,
    passwordChallenge: undefined,
    passphraseChallenge: undefined,
    kiChallenge: undefined,
    connected: undefined,
    disconnected: undefined,
    ...fields,
  }
}

function waitForChallenge<T>(state: SessionState, key: string, event: SshSessionEvent): Promise<T> {
  return new Promise((resolve, reject) => {
    state.pending.set(key, { resolve, reject })
    state.queue.push(event)
  })
}

// ── Types ─────────────────────────────────────────────────────────────────────

type AuthMethod = {
  type: 'none' | 'prompt-password' | 'hostbased'
} | {
  type: 'keyboard-interactive'
  savedPassword?: string
} | {
  type: 'saved-password'
  password: string
} | {
  type: 'publickey'
  name: string
  contents: Uint8Array
} | ({
  type: 'agent'
  publicKey?: russh.SshPublicKey
} & ({
  kind: 'unix-socket'
  path: string
} | {
  kind: 'named-pipe'
  path: string
} | {
  kind: 'pageant'
}))

function sshAuthTypeForMethod(m: AuthMethod): string {
  switch (m.type) {
    case 'none': return 'none'
    case 'hostbased': return 'hostbased'
    case 'prompt-password': return 'password'
    case 'saved-password': return 'password'
    case 'keyboard-interactive': return 'keyboard-interactive'
    case 'publickey': return 'publickey'
    case 'agent': return 'publickey'
  }
}

interface PendingChallenge {
  resolve: (value: any) => void
  reject: (reason?: any) => void
}

interface ForwardedPort {
  config: {
    type: string
    host: string
    port: number
    targetAddress: string
    targetPort: number
  }
  listener: Server | null
}

class SessionState {
  ssh: russh.SSHClient | russh.AuthenticatedSSHClient | null = null
  sftp: russh.SFTP | null = null
  sftpHandles = new Map<string, russh.SFTPFile>()
  shell: russh.Channel | null = null
  queue = new AsyncQueue<SshSessionEvent>()
  shellQueue = new AsyncQueue<SshShellEvent>()
  pending = new Map<string, PendingChallenge>()
  forwardedPorts: ForwardedPort[] = []
  authUsername: string | null = null
  savedPassword: string | null = null
  previouslyDisconnected = false
}

// ── Module-level state ────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>()
export const jumpChannels = new Map<string, russh.NewChannel>()

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

// ── Keytar helpers ────────────────────────────────────────────────────────────

function keytarKeyForRequest(req: SshConnectRequest): string {
  return req.port && req.port !== 22
    ? `ssh@${req.host}:${req.port}`
    : `ssh@${req.host}`
}

async function loadPassword(req: SshConnectRequest, username?: string): Promise<string | null> {
  const key = keytarKeyForRequest(req)
  const account = username ?? req.user ?? ''
  try {
    return await keytar.getPassword(key, account)
  } catch {
    return null
  }
}

async function savePassword(req: SshConnectRequest, password: string, username?: string): Promise<void> {
  const key = keytarKeyForRequest(req)
  const account = username ?? req.user ?? ''
  try {
    await keytar.setPassword(key, account, password)
  } catch { /* ignore */ }
}

async function deletePassword(req: SshConnectRequest, username?: string): Promise<void> {
  const key = keytarKeyForRequest(req)
  const account = username ?? req.user ?? ''
  try {
    await keytar.deletePassword(key, account)
  } catch { /* ignore */ }
}

async function loadPrivateKeyPassword(keyHash: string): Promise<string | null> {
  try {
    return await keytar.getPassword('tabby-ssh-key-passphrase', keyHash)
  } catch {
    return null
  }
}

async function savePrivateKeyPassword(keyHash: string, passphrase: string): Promise<void> {
  try {
    await keytar.setPassword('tabby-ssh-key-passphrase', keyHash, passphrase)
  } catch { /* ignore */ }
}

async function deletePrivateKeyPassword(keyHash: string): Promise<void> {
  try {
    await keytar.deletePassword('tabby-ssh-key-passphrase', keyHash)
  } catch { /* ignore */ }
}

// ── Private key loading ───────────────────────────────────────────────────────

async function loadPrivateKey(
  sessionId: string,
  _name: string,
  privateKeyContents: Uint8Array,
  state: SessionState,
): Promise<russh.KeyPair> {
  let privateKey = new TextDecoder().decode(privateKeyContents)
  privateKey = privateKey.replaceAll('EC PRIVATE KEY', 'PRIVATE KEY')
  const keyHash = crypto.createHash('sha512').update(privateKey).digest('hex')

  let triedSavedPassphrase = false
  let passphrase: string | null = null

  while (true) {
    try {
      return await russh.KeyPair.parse(privateKey, passphrase ?? undefined)
    } catch (e: any) {
      if (!triedSavedPassphrase) {
        passphrase = await loadPrivateKeyPassword(keyHash)
        triedSavedPassphrase = true
        continue
      }

      const encryptedErrors = [
        'Error: Keys(KeyIsEncrypted)',
        'Error: Keys(SshKey(Ppk(Encrypted)))',
        'Error: Keys(SshKey(Ppk(IncorrectMac)))',
        'Error: Keys(SshKey(Crypto))',
      ]

      if (encryptedErrors.includes(e.toString())) {
        await deletePrivateKeyPassword(keyHash)
        const response = await waitForChallenge<{ passphrase: string; remember: boolean }>(
          state,
          `${sessionId}:passphrase`,
          ev('passphrase_challenge', {
            passphraseChallenge: { keyHash },
          }),
        )
        if (!response.passphrase) {
          throw new Error('Passphrase prompt cancelled')
        }
        passphrase = response.passphrase
        if (response.remember) {
          await savePrivateKeyPassword(keyHash, passphrase)
        }
      } else {
        throw e
      }
    }
  }
}

// ── X11 display resolution ────────────────────────────────────────────────────

function resolveX11DisplaySpec(spec?: string | null): { path: string } | { host: string; port: number } {
  const [, xHostRaw, xDisplay] = /^(.+):(\d+)(?:\.\d+)?$/.exec(spec ?? process.env.DISPLAY ?? 'localhost:0') ?? [undefined, undefined, undefined]
  let xHost = xHostRaw
  if (process.platform === 'win32') {
    xHost ??= 'localhost'
  } else {
    xHost ??= 'unix'
  }

  if (spec?.startsWith('/')) {
    xHost = spec
  }

  const display = parseInt(xDisplay ?? '0')
  const port = display < 100 ? display + 6000 : display

  if (xHost === 'unix') {
    xHost = `/tmp/.X11-unix/X${display}`
  }

  if (xHost.startsWith('/')) {
    return { path: xHost }
  }
  return { host: xHost, port }
}

// ── Socket channel bridge ─────────────────────────────────────────────────────

function setupSocketChannelEvents(channel: russh.Channel, socket: Socket): void {
  channel.data$.subscribe({
    next: (data: any) => socket.write(data),
    error: () => socket.destroy(),
  })

  socket.on('data', (data: Buffer) => {
    try {
      channel.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    } catch {
      socket.destroy()
    }
  })

  channel.eof$.subscribe(() => socket.end())
  channel.closed$.subscribe(() => socket.destroy())
  socket.on('error', () => channel.close())
  socket.on('close', () => channel.close())
  socket.on('end', () => channel.eof())
}

// ── Agent connection spec ─────────────────────────────────────────────────────

async function getAgentConnectionSpec(
  req: SshConnectRequest,
  emitServiceMessage: (msg: string) => void,
): Promise<russh.AgentConnectionSpec | null> {
  if (process.platform === 'win32') {
    const agentType = req.agentType || 'auto'
    if (agentType === 'pageant') {
      return { kind: 'pageant' }
    } else if (agentType === 'auto') {
      let pipeExists = false
      try {
        await fs.stat(WINDOWS_OPENSSH_AGENT_PIPE)
        pipeExists = true
      } catch (e: any) {
        if (e.code === 'EBUSY') {
          pipeExists = true
        }
      }
      if (pipeExists) {
        return { kind: 'named-pipe', path: WINDOWS_OPENSSH_AGENT_PIPE }
      } else if (russh.isPageantRunning()) {
        return { kind: 'pageant' }
      } else {
        emitServiceMessage(' ! Agent auth selected, but no running Agent process is found')
        return null
      }
    } else {
      return {
        kind: 'named-pipe',
        path: req.agentPath || WINDOWS_OPENSSH_AGENT_PIPE,
      }
    }
  } else {
    const configuredPath = (req.agentPath ?? '').trim()
    const envPath = (process.env.SSH_AUTH_SOCK ?? '').trim()
    const agentSocketPath = configuredPath || envPath

    if (!agentSocketPath) {
      emitServiceMessage(' ! Agent auth selected, but SSH_AUTH_SOCK is not set')
      return null
    }

    if (!agentSocketPath.startsWith('@')) {
      try {
        const stat = await fs.stat(agentSocketPath)
        if (!stat.isSocket()) {
          emitServiceMessage(` ! Agent socket path is not a Unix socket: ${agentSocketPath}`)
          return null
        }
      } catch (e) {
        emitServiceMessage(` ! Could not access agent socket ${agentSocketPath}: ${e}`)
        return null
      }
    }

    return { kind: 'unix-socket', path: agentSocketPath }
  }
}

// ── Auth method builder ───────────────────────────────────────────────────────

async function buildAuthMethods(
  req: SshConnectRequest,
  emitServiceMessage: (msg: string) => void,
): Promise<AuthMethod[]> {
  const methods: AuthMethod[] = [{ type: 'none' }]
  const auth = req.auth || ''

  if (!auth || auth === 'publicKey') {
    for (const pk of req.privateKeys ?? []) {
      // Skip .pub-like entries
      try {
        russh.parsePublicKey(new TextDecoder().decode(pk.contents))
        emitServiceMessage(` ! Expected a private key, but ${pk.name} appears to be a public key. Skipping it.`)
        continue
      } catch {
        // Not a public key — this is a private key, proceed
      }
      methods.push({ type: 'publickey', name: pk.name, contents: pk.contents })
    }
  }

  if (!auth || auth === 'agent') {
    const spec = await getAgentConnectionSpec(req, emitServiceMessage)
    if (spec) {
      for (const pk of req.privateKeys ?? []) {
        try {
          const publicKey = russh.parsePublicKey(new TextDecoder().decode(pk.contents))
          methods.push({ type: 'agent', ...spec, publicKey } as AuthMethod)
          emitServiceMessage(`Loaded public key for agent auth: ${pk.name}`)
        } catch (error) {
          emitServiceMessage(`Could not load public key for agent auth from ${pk.name}: ${error}`)
        }
      }
      methods.push({ type: 'agent', ...spec } as AuthMethod)
    }
  }

  if (!auth || auth === 'password') {
    if (req.password) {
      methods.push({ type: 'saved-password', password: req.password })
    }
  }

  if (!auth || auth === 'keyboardInteractive') {
    if (req.password) {
      methods.push({ type: 'keyboard-interactive', savedPassword: req.password })
    }
    methods.push({ type: 'keyboard-interactive' })
  }

  if (!auth || auth === 'password') {
    methods.push({ type: 'prompt-password' })
  }

  methods.push({ type: 'hostbased' })

  return methods
}

function populateStoredPasswords(methods: AuthMethod[], storedPassword: string, auth: string): void {
  if (!auth || auth === 'password') {
    const hasSaved = methods.some(m => m.type === 'saved-password' && (m as any).password === storedPassword)
    if (!hasSaved) {
      const promptIndex = methods.findIndex(m => m.type === 'prompt-password')
      const insertIndex = promptIndex >= 0 ? promptIndex : methods.length
      methods.splice(insertIndex, 0, { type: 'saved-password', password: storedPassword })
    }
  }

  if (!auth || auth === 'keyboardInteractive') {
    const existing = methods.find(m => m.type === 'keyboard-interactive' && (m as any).savedPassword === storedPassword)
    if (!existing) {
      const updatable = methods.find(m => m.type === 'keyboard-interactive' && (m as any).savedPassword === undefined)
      if (updatable && updatable.type === 'keyboard-interactive') {
        (updatable as any).savedPassword = storedPassword
      } else {
        methods.push({ type: 'keyboard-interactive', savedPassword: storedPassword })
      }
    }
  }
}

// ── Auth loop ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line max-statements
async function runAuthLoop(
  sessionId: string,
  req: SshConnectRequest,
  state: SessionState,
  allAuthMethods: AuthMethod[],
): Promise<russh.AuthenticatedSSHClient | null> {
  const ssh = state.ssh
  if (!(ssh instanceof russh.SSHClient)) {
    throw new Error('Wrong state for auth handling')
  }
  if (!state.authUsername) {
    throw new Error('No username')
  }

  const emitServiceMessage = (msg: string) => {
    state.queue.push(ev('service_message', { serviceMessageText: msg }))
  }

  const noneResult = await ssh.authenticateNone(state.authUsername)
  if (noneResult instanceof russh.AuthenticatedSSHClient) {
    return noneResult
  }

  let remainingMethods = [...allAuthMethods]
  let methodsLeft = noneResult.remainingMethods

  function maybeSetRemainingMethods(r: russh.AuthFailure) {
    if (r.remainingMethods.length) {
      methodsLeft = r.remainingMethods
    }
  }

  while (true) {
    const m = methodsLeft
    const method = remainingMethods.find(x => m.length === 0 || m.includes(sshAuthTypeForMethod(x)))

    if (state.previouslyDisconnected || !method) {
      return null
    }

    remainingMethods = remainingMethods.filter(x => x !== method)

    if (method.type === 'saved-password') {
      emitServiceMessage('Using saved password')
      const result = await ssh.authenticateWithPassword(state.authUsername, method.password)
      if (result instanceof russh.AuthenticatedSSHClient) {
        return result
      }
      maybeSetRemainingMethods(result)
    }

    if (method.type === 'prompt-password') {
      const storedPassword = await loadPassword(req, state.authUsername)
      const response = await waitForChallenge<{ password: string | null; remember: boolean }>(
        state,
        `${sessionId}:password`,
        ev('password_challenge', {
          passwordChallenge: {
            username: state.authUsername,
            host: req.host,
            hasStoredPassword: !!storedPassword,
            storedPassword: storedPassword ?? '',
          },
        }),
      )
      if (response.password == null) {
        continue
      }
      if (response.remember) {
        state.savedPassword = response.password
      }
      const result = await ssh.authenticateWithPassword(state.authUsername, response.password)
      if (result instanceof russh.AuthenticatedSSHClient) {
        return result
      }
      maybeSetRemainingMethods(result)
    }

    if (method.type === 'publickey') {
      try {
        emitServiceMessage(`Trying private key: ${method.name}`)
        const key = await loadPrivateKey(sessionId, method.name, method.contents, state)
        const result = await ssh.authenticateWithKeyPair(state.authUsername, key, null)
        if (result instanceof russh.AuthenticatedSSHClient) {
          return result
        }
        maybeSetRemainingMethods(result)
      } catch (e) {
        emitServiceMessage(` ! Failed to load private key ${method.name}: ${e}`)
        continue
      }
    }

    if (method.type === 'keyboard-interactive') {
      let kiState: russh.AuthenticatedSSHClient | russh.KeyboardInteractiveAuthenticationState =
        await ssh.startKeyboardInteractiveAuthentication(state.authUsername)

      while (true) {
        if (kiState.state === 'failure') {
          maybeSetRemainingMethods({ remainingMethods: kiState.remainingMethods })
          break
        }

        // kiState.state === 'infoRequest'
        const prompts = kiState.prompts() ?? []
        let responses: string[] = []

        if (prompts.length > 0) {
          const prefilledResponses: string[] = new Array(prompts.length).fill('')
          if (method.savedPassword) {
            for (let i = 0; i < prompts.length; i++) {
              const p = prompts[i]
              if (p.prompt.toLowerCase().includes('password') && !p.echo) {
                prefilledResponses[i] = method.savedPassword
              }
            }
          }

          const allPrefilled = prompts.every((p, i) =>
            !(!p.echo && p.prompt.toLowerCase().includes('password')) || prefilledResponses[i] !== '',
          )

          if (allPrefilled && method.savedPassword) {
            responses = prefilledResponses
          } else {
            try {
              const kiResponse = await waitForChallenge<string[]>(
                state,
                `${sessionId}:ki`,
                ev('ki_challenge', {
                  kiChallenge: {
                    name: kiState.name,
                    instructions: kiState.instructions,
                    prompts: prompts.map(p => ({ prompt: p.prompt, echo: p.echo })),
                  },
                }),
              )
              responses = kiResponse
            } catch {
              break
            }
          }
        }

        const nextKiState = await ssh.continueKeyboardInteractiveAuthentication(responses)
        if (nextKiState instanceof russh.AuthenticatedSSHClient) {
          return nextKiState
        }
        kiState = nextKiState
      }
    }

    if (method.type === 'agent') {
      try {
        const result = (method as any).publicKey
          ? await ssh.authenticateWithAgentIdentity(state.authUsername, method as any, (method as any).publicKey)
          : await ssh.authenticateWithAgent(state.authUsername, method as any)
        if (result instanceof russh.AuthenticatedSSHClient) {
          return result
        }
        maybeSetRemainingMethods(result)
      } catch (e) {
        const identitySuffix = (method as any).publicKey ? ` with identity ${(method as any).publicKey.fingerprint()}` : ''
        emitServiceMessage(` ! Failed to authenticate using agent${identitySuffix}: ${e}`)
        continue
      }
    }
  }
}

// ── Port forwarding ───────────────────────────────────────────────────────────

async function startLocalForward(
  fw: SshPortForwardRequest,
  state: SessionState,
): Promise<Server> {
  const emitServiceMessage = (msg: string) => {
    state.queue.push(ev('service_message', { serviceMessageText: msg }))
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (socket: Socket) => {
      if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
        socket.destroy()
        return
      }
      try {
        const channel = await state.ssh.activateChannel(await state.ssh.openTCPForwardChannel({
          addressToConnectTo: fw.targetAddress,
          portToConnectTo: fw.targetPort,
          originatorAddress: socket.remoteAddress ?? '127.0.0.1',
          originatorPort: socket.remotePort ?? 0,
        }))
        setupSocketChannelEvents(channel, socket)
      } catch (err) {
        emitServiceMessage(` X Remote rejected forwarded connection to ${fw.targetAddress}:${fw.targetPort}: ${err}`)
        socket.destroy()
      }
    })

    server.on('error', reject)
    server.listen(fw.port, fw.host, () => {
      emitServiceMessage(` -> Forwarded (local) ${fw.host}:${fw.port} -> ${fw.targetAddress}:${fw.targetPort}`)
      resolve(server)
    })
  })
}

async function startDynamicForward(
  fw: SshPortForwardRequest,
  state: SessionState,
): Promise<Server> {
  const emitServiceMessage = (msg: string) => {
    state.queue.push(ev('service_message', { serviceMessageText: msg }))
  }

  return new Promise((resolve, reject) => {
    let socksv5: any
    try {
      socksv5 = require('@luminati-io/socksv5')
    } catch {
      reject(new Error('socksv5 module not available for dynamic forwarding'))
      return
    }

    const server: Server = socksv5.createServer(async (info: any, acceptConnection: any, rejectConnection: any) => {
      if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
        rejectConnection()
        return
      }
      try {
        const channel = await state.ssh.activateChannel(await state.ssh.openTCPForwardChannel({
          addressToConnectTo: info.dstAddr,
          portToConnectTo: info.dstPort,
          originatorAddress: '127.0.0.1',
          originatorPort: 0,
        }))
        const socket: Socket = acceptConnection(true)
        setupSocketChannelEvents(channel, socket)
      } catch (err) {
        emitServiceMessage(` X Dynamic forward rejected: ${err}`)
        rejectConnection()
      }
    })

    server.on('error', reject)
    server.listen(fw.port, fw.host, () => {
      emitServiceMessage(` -> Forwarded (dynamic) ${fw.host}:${fw.port}`)
      resolve(server)
    })
    ;(server as any)['useAuth'](socksv5.auth.None())
  })
}

// ── SFTP lazy init ────────────────────────────────────────────────────────────

async function ensureSFTP(state: SessionState): Promise<russh.SFTP> {
  if (state.sftp) {
    return state.sftp
  }
  if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
    throw new Error('Cannot open SFTP before authentication')
  }
  state.sftp = await state.ssh.activateSFTP(await state.ssh.openSessionChannel())
  return state.sftp
}

// ── Session cleanup ───────────────────────────────────────────────────────────

function cleanupSession(sessionId: string, state: SessionState): void {
  for (const fp of state.forwardedPorts) {
    fp.listener?.close()
  }
  state.forwardedPorts = []
  state.sftp = null
  state.shell = null
  state.ssh = null
  state.queue.close()
  state.shellQueue.close()
  // Reject all pending challenges
  for (const [, pending] of state.pending) {
    pending.reject(new Error(`Session ${sessionId} was destroyed`))
  }
  state.pending.clear()
  sessions.delete(sessionId)
}

// ── Connect session ───────────────────────────────────────────────────────────

// eslint-disable-next-line max-statements
async function connectSession(
  sessionId: string,
  req: SshConnectRequest,
  state: SessionState,
): Promise<void> {
  const emitServiceMessage = (msg: string) => {
    state.queue.push(ev('service_message', { serviceMessageText: msg }))
  }

  // 1. Build transport
  let transport: russh.SshTransport
  if (req.proxyCommand) {
    emitServiceMessage(` Proxy command: using ${req.proxyCommand}`)
    const argv = req.proxyCommand.split(/\s+/)
    transport = await russh.SshTransport.newCommand(argv[0], argv.slice(1))
  } else if (req.jumpChannelId) {
    const jumpChannel = jumpChannels.get(req.jumpChannelId)
    if (!jumpChannel) {
      throw new Error(`Jump channel not found: ${req.jumpChannelId}`)
    }
    jumpChannels.delete(req.jumpChannelId)
    transport = await russh.SshTransport.newSshChannel(jumpChannel.take())
  } else if (req.socksProxyHost) {
    emitServiceMessage(` Proxy: using SOCKS ${req.socksProxyHost}:${req.socksProxyPort}`)
    transport = await russh.SshTransport.newSocksProxy(
      req.socksProxyHost,
      req.socksProxyPort ?? 1080,
      req.host,
      req.port ?? 22,
    )
  } else if (req.httpProxyHost) {
    emitServiceMessage(` Proxy: using HTTP ${req.httpProxyHost}:${req.httpProxyPort}`)
    transport = await russh.SshTransport.newHttpProxy(
      req.httpProxyHost,
      req.httpProxyPort ?? 8080,
      req.host,
      req.port ?? 22,
    )
  } else {
    transport = await russh.SshTransport.newSocket(`${req.host.trim()}:${req.port ?? 22}`)
  }

  // 2. Connect with host key verification
  state.ssh = await russh.SSHClient.connect(
    transport,
    async (key: russh.SshPublicKey) => {
      const algo = key.algorithm()
      const fingerprint = key.fingerprint()
      const digest = crypto.createHash('sha256').update(key.bytes()).digest('base64')
      const accepted = await waitForChallenge<boolean>(
        state,
        `${sessionId}:host_key`,
        ev('host_key_challenge', {
          hostKeyChallenge: { algo, fingerprint, digest },
        }),
      )
      return accepted
    },
    {
      keepaliveIntervalSeconds: req.keepaliveIntervalMs
        ? Math.round(req.keepaliveIntervalMs / 1000)
        : undefined,
      keepaliveCountMax: req.keepaliveCountMax || undefined,
      connectionTimeoutSeconds: req.readyTimeoutMs
        ? Math.round(req.readyTimeoutMs / 1000)
        : undefined,
    },
  )

  // 3. Disconnect subscription
  state.ssh.disconnect$.subscribe(() => {
    if (!state.previouslyDisconnected) {
      state.previouslyDisconnected = true
      setTimeout(() => {
        state.queue.push(ev('disconnected', { disconnected: { reason: 'remote disconnect' } }))
        cleanupSession(sessionId, state)
      })
    }
  })

  // 4. Banner subscription
  if (!req.skipBanner) {
    state.ssh.banner$.subscribe((banner: string) => {
      emitServiceMessage(banner)
    })
  }

  // 5. Determine username
  state.authUsername = req.user || null
  if (!state.authUsername) {
    state.authUsername = await waitForChallenge<string>(
      state,
      `${sessionId}:username`,
      ev('username_challenge', {
        usernameChallenge: { host: req.host },
      }),
    )
  }

  if (state.authUsername?.startsWith('$')) {
    state.authUsername = process.env[state.authUsername.slice(1)] ?? state.authUsername
  }

  // 6. Build auth methods
  const allAuthMethods = await buildAuthMethods(req, emitServiceMessage)

  // 7. Populate stored passwords
  const storedPassword = await loadPassword(req, state.authUsername)
  if (storedPassword) {
    populateStoredPasswords(allAuthMethods, storedPassword, req.auth || '')
  }

  // 8. Run auth loop
  const authSub = state.ssh.disconnect$.subscribe(() => {
    const publicKeyCount = allAuthMethods.filter(m => m.type === 'publickey').length
    if (!req.auth && publicKeyCount >= 3) {
      emitServiceMessage('The server has disconnected during authentication.')
      emitServiceMessage('This may happen if too many private key authentication attempts are made.')
      emitServiceMessage('You can set the specific private key for authentication in the profile settings.')
    }
  })

  let authenticatedClient: russh.AuthenticatedSSHClient | null
  try {
    authenticatedClient = await runAuthLoop(sessionId, req, state, allAuthMethods)
  } finally {
    authSub.unsubscribe()
  }

  if (!authenticatedClient) {
    state.ssh.disconnect()
    await deletePassword(req, state.authUsername)
    throw new Error('Authentication rejected')
  }

  state.ssh = authenticatedClient

  // Save password if user asked to remember
  if (state.savedPassword) {
    await savePassword(req, state.savedPassword, state.authUsername)
  }

  // 9. Set up channel subscriptions
  const authedSsh = state.ssh as russh.AuthenticatedSSHClient

  authedSsh.tcpChannelOpen$.subscribe(async (event: any) => {
    const channel = await authedSsh.activateChannel(event.channel)
    const forward = state.forwardedPorts.find(
      f => f.config.port === event.targetPort && f.config.host === event.targetAddress,
    )
    if (!forward) {
      emitServiceMessage(` X Rejected incoming forwarded connection for unrecognized port ${event.targetAddress}:${event.targetPort}`)
      channel.close()
      return
    }
    const socket = new Socket()
    socket.connect(forward.config.targetPort, forward.config.targetAddress)
    socket.on('error', (e: Error) => {
      emitServiceMessage(` X Could not forward remote connection to ${forward.config.targetAddress}:${forward.config.targetPort}: ${e}`)
      channel.close()
    })
    setupSocketChannelEvents(channel, socket)
  })

  authedSsh.x11ChannelOpen$.subscribe(async (event: any) => {
    const channel = await authedSsh.activateChannel(event.channel)
    const displaySpec = (req.x11Display || process.env.DISPLAY) ?? 'localhost:0'
    const connectOpts = resolveX11DisplaySpec(displaySpec)
    const socket = new Socket()
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', resolve)
        socket.on('error', reject)
        socket.connect(connectOpts as any)
      })
      setupSocketChannelEvents(channel, socket)
    } catch (e) {
      emitServiceMessage(` X Could not connect to the X server: ${e}`)
      emitServiceMessage(`    Tabby tried to connect to ${JSON.stringify(connectOpts)} based on DISPLAY (${displaySpec})`)
      channel.close()
    }
  })

  authedSsh.agentChannelOpen$.subscribe(async (newChannel: any) => {
    const channel = await authedSsh.activateChannel(newChannel)
    const spec = await getAgentConnectionSpec(req, emitServiceMessage)
    if (!spec) {
      await channel.close()
      return
    }
    const agent = await russh.SSHAgentStream.connect(spec)
    channel.data$.subscribe((data: any) => agent.write(data))
    agent.data$.subscribe(
      (data: any) => channel.write(data),
      undefined,
      () => channel.close(),
    )
    channel.closed$.subscribe(() => agent.close())
  })

  // 10. Signal connected
  state.queue.push(ev('connected', {
    connected: { authUsername: state.authUsername },
  }))
}

// ── Service implementation ────────────────────────────────────────────────────

export const sshService: SshService = {
  async *Connect(request: SshConnectRequest, ctx: StreamContext): AsyncIterable<SshSessionEvent> {
    const sessionId = request.sessionId
    const state = new SessionState()
    sessions.set(sessionId, state)

    ctx.signal.addEventListener('abort', () => {
      cleanupSession(sessionId, state)
    })

    // Launch connection in background — do not await
    connectSession(sessionId, request, state).catch((err: Error) => {
      state.queue.push(ev('disconnected', { disconnected: { reason: err.message } }))
      state.queue.close()
      sessions.delete(sessionId)
    })

    yield* state.queue
  },

  async RespondHostKey(request: SshHostKeyResponse, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}
    const key = `${request.sessionId}:host_key`
    const pending = state.pending.get(key)
    if (pending) {
      state.pending.delete(key)
      pending.resolve(request.accepted)
    }
    return {}
  },

  async RespondUsername(request: SshUsernameResponse, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}
    const key = `${request.sessionId}:username`
    const pending = state.pending.get(key)
    if (pending) {
      state.pending.delete(key)
      pending.resolve(request.username)
    }
    return {}
  },

  async RespondPassword(request: SshPasswordResponse, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}
    const key = `${request.sessionId}:password`
    const pending = state.pending.get(key)
    if (pending) {
      state.pending.delete(key)
      pending.resolve({ password: request.password || null, remember: request.remember })
    }
    return {}
  },

  async RespondPassphrase(request: SshPassphraseResponse, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}
    const key = `${request.sessionId}:passphrase`
    const pending = state.pending.get(key)
    if (pending) {
      state.pending.delete(key)
      pending.resolve({ passphrase: request.passphrase || null, remember: request.remember })
    }
    return {}
  },

  async RespondKi(request: SshKiResponse, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}
    const key = `${request.sessionId}:ki`
    const pending = state.pending.get(key)
    if (pending) {
      state.pending.delete(key)
      pending.resolve(request.responses)
    }
    return {}
  },

  async Destroy(request: SshSessionId, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}
    state.ssh?.disconnect()
    cleanupSession(request.sessionId, state)
    return {}
  },

  async *OpenShell(request: SshOpenShellRequest, ctx: StreamContext): AsyncIterable<SshShellEvent> {
    const state = sessions.get(request.sessionId)
    if (!state) return

    if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
      throw new Error('Cannot open shell before authentication')
    }

    const ch = await state.ssh.activateChannel(await state.ssh.openSessionChannel())
    await ch.requestPTY('xterm-256color', { columns: 80, rows: 24, pixHeight: 0, pixWidth: 0 })

    if (request.x11) {
      await ch.requestX11Forwarding({
        singleConnection: false,
        authProtocol: 'MIT-MAGIC-COOKIE-1',
        authCookie: crypto.randomBytes(16).toString('hex'),
        screenNumber: 0,
      })
    }

    state.shell = ch

    const shellQueue = new AsyncQueue<SshShellEvent>()
    state.shellQueue = shellQueue

    ch.data$.subscribe((data: Uint8Array) => {
      shellQueue.push({ data: Buffer.from(data), closed: false })
    })

    ch.closed$.subscribe(() => {
      shellQueue.push({ data: Buffer.alloc(0), closed: true })
      shellQueue.close()
    })

    ch.eof$.subscribe(() => {
      shellQueue.push({ data: Buffer.alloc(0), closed: true })
      shellQueue.close()
    })

    ctx.signal.addEventListener('abort', () => {
      shellQueue.close()
    })

    await ch.requestShell()

    yield* shellQueue
  },

  async WriteShell(request: SshShellWriteRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (state?.shell) {
      state.shell.write(request.data)
    }
    return {}
  },

  async ResizeShell(request: SshShellResizeRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (state?.shell) {
      state.shell.resizePTY({ columns: request.cols, rows: request.rows, pixWidth: 0, pixHeight: 0 })
    }
    return {}
  },

  async SftpReaddir(request: SshSftpPathRequest, _ctx: RequestContext): Promise<SshSftpReaddirResult> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    const entries = await sftp.readDirectory(request.path)
    return {
      entries: entries.map(e => ({
        name: e.name,
        fileType: e.metadata.type === 0 ? 2 : e.metadata.type === 2 ? 3 : 1,
        permissions: e.metadata.permissions ?? 0,
        size: Number(e.metadata.size),
        mtime: Math.floor(Number(e.metadata.mtime ?? 0)),
      })),
    }
  },

  async SftpStat(request: SshSftpPathRequest, _ctx: RequestContext): Promise<SshSftpStatResult> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    const stat = await sftp.stat(request.path)
    return {
      fileType: stat.type === 0 ? 2 : stat.type === 2 ? 3 : 1,
      permissions: stat.permissions ?? 0,
      size: Number(stat.size),
      mtime: Math.floor(Number(stat.mtime ?? 0)),
    }
  },

  async SftpReadlink(request: SshSftpPathRequest, _ctx: RequestContext): Promise<StringValue> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    const target = await sftp.readlink(request.path)
    return { value: target as string }
  },

  async SftpOpen(request: SshSftpOpenRequest, _ctx: RequestContext): Promise<SshSftpOpenResult> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    const handle = await sftp.open(request.path, request.flags as any)
    const handleId = crypto.randomUUID()
    state.sftpHandles.set(handleId, handle)
    return { handleId }
  },

  async SftpRead(request: SshSftpReadRequest, _ctx: RequestContext): Promise<SshSftpReadResult> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const handle = state.sftpHandles.get(request.handleId)
    if (!handle) throw new Error(`Invalid SFTP handle: ${request.handleId}`)
    const data = await handle.read(request.length)
    return { data: Buffer.from(data) }
  },

  async SftpWrite(request: SshSftpWriteRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const handle = state.sftpHandles.get(request.handleId)
    if (!handle) throw new Error(`Invalid SFTP handle: ${request.handleId}`)
    await handle.writeAll(request.data)
    return {}
  },

  async SftpClose(request: SshSftpHandleRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const handle = state.sftpHandles.get(request.handleId)
    if (!handle) throw new Error(`Invalid SFTP handle: ${request.handleId}`)
    await handle.shutdown()
    state.sftpHandles.delete(request.handleId)
    return {}
  },

  async SftpRmdir(request: SshSftpPathRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    await sftp.removeDirectory(request.path)
    return {}
  },

  async SftpMkdir(request: SshSftpPathRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    await sftp.createDirectory(request.path)
    return {}
  },

  async SftpRename(request: SshSftpRenameRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    await sftp.rename(request.oldPath, request.newPath)
    return {}
  },

  async SftpUnlink(request: SshSftpPathRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    await sftp.removeFile(request.path)
    return {}
  },

  async SftpChmod(request: SshSftpChmodRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    const sftp = await ensureSFTP(state)
    await sftp.chmod(request.path, request.mode)
    return {}
  },

  async AddPortForward(request: SshPortForwardRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)

    const emitServiceMessage = (msg: string) => {
      state.queue.push(ev('service_message', { serviceMessageText: msg }))
    }

    if (request.type === 'Local') {
      const server = await startLocalForward(request, state)
      state.forwardedPorts.push({ config: request, listener: server })
    } else if (request.type === 'Dynamic') {
      const server = await startDynamicForward(request, state)
      state.forwardedPorts.push({ config: request, listener: server })
    } else if (request.type === 'Remote') {
      if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
        throw new Error('Cannot add remote port forward before authentication')
      }
      try {
        await state.ssh.forwardTCPPort(request.host, request.port)
        emitServiceMessage(` <- Forwarded (remote) ${request.host}:${request.port} -> ${request.targetAddress}:${request.targetPort}`)
        state.forwardedPorts.push({ config: request, listener: null })
      } catch (err) {
        emitServiceMessage(` X Remote rejected port forwarding for ${request.host}:${request.port}: ${err}`)
        throw err
      }
    }

    return {}
  },

  async RemovePortForward(request: SshPortForwardRequest, _ctx: RequestContext): Promise<Empty> {
    const state = sessions.get(request.sessionId)
    if (!state) return {}

    const emitServiceMessage = (msg: string) => {
      state.queue.push(ev('service_message', { serviceMessageText: msg }))
    }

    const entry = state.forwardedPorts.find(
      f => f.config.type === request.type && f.config.host === request.host && f.config.port === request.port,
    )
    if (!entry) return {}

    if (request.type === 'Local' || request.type === 'Dynamic') {
      entry.listener?.close()
    } else if (request.type === 'Remote') {
      if (state.ssh instanceof russh.AuthenticatedSSHClient) {
        state.ssh.stopForwardingTCPPort(request.host, request.port)
      }
    }

    state.forwardedPorts = state.forwardedPorts.filter(f => f !== entry)
    emitServiceMessage(`Stopped forwarding ${request.type} ${request.host}:${request.port}`)

    return {}
  },

  async OpenJumpChannel(request: SshJumpChannelRequest, _ctx: RequestContext): Promise<StringValue> {
    const state = sessions.get(request.sessionId)
    if (!state) throw new Error(`No SSH session: ${request.sessionId}`)
    if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
      throw new Error('Jump session is not authenticated')
    }
    const newChannel = await state.ssh.openTCPForwardChannel({
      addressToConnectTo: request.targetHost,
      portToConnectTo: request.targetPort,
      originatorAddress: '127.0.0.1',
      originatorPort: 0,
    })
    const jumpChannelId = crypto.randomUUID()
    jumpChannels.set(jumpChannelId, newChannel)
    return { value: jumpChannelId }
  },
}
