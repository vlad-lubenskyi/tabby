/**
 * Main-process SSH session manager.
 * Exposes russh via Electron IPC channels so the sandboxed renderer never
 * touches Node.js or native modules directly.
 *
 * Session lifecycle:
 *   renderer creates UUID → calls ssh:session:connect → main manages all russh
 *   state → auth challenges are signalled via events and resolved through
 *   one-shot ipcMain.once handlers.
 */

import { ipcMain, WebContents } from 'electron'
import * as russh from 'russh'
import * as fs from 'mz/fs'
import * as crypto from 'crypto'
import { Socket, createServer, Server } from 'net'
import * as keytar from 'keytar'
import { v4 as uuidv4 } from 'uuid'
import type { Application } from './app'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SSHProfile {
    options: {
        host: string
        port?: number
        user?: string
        auth?: null | 'password' | 'publicKey' | 'agent' | 'keyboardInteractive'
        password?: string
        privateKeys?: string[]
        keepaliveInterval?: number
        keepaliveCountMax?: number
        readyTimeout?: number | null
        x11?: boolean
        skipBanner?: boolean
        agentForward?: boolean
        algorithms?: Record<string, string[]>
        proxyCommand?: string | null
        socksProxyHost?: string | null
        socksProxyPort?: number | null
        httpProxyHost?: string | null
        httpProxyPort?: number | null
        agentType?: string
        agentPath?: string
        x11Display?: string
    }
    jumpChannelId?: string | null
}

export interface ForwardingConfig {
    type: 'Local' | 'Remote' | 'Dynamic'
    host: string
    port: number
    targetAddress: string
    targetPort: number
}

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

function sshAuthTypeForMethod (m: AuthMethod): string {
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

// ── Session state ─────────────────────────────────────────────────────────────

class SSHSessionState {
    ssh: russh.SSHClient | russh.AuthenticatedSSHClient | null = null
    sftp: russh.SFTP | null = null
    sftpHandles = new Map<string, russh.SFTPFile>()
    shell: russh.Channel | null = null
    webContents: WebContents
    forwardedPorts: Array<{ config: ForwardingConfig; listener: Server | null }> = []
    authUsername: string | null = null
    savedPassword: string | null = null
    previouslyDisconnected = false

    constructor (wc: WebContents) {
        this.webContents = wc
    }

    send (channel: string, ...args: any[]): void {
        if (!this.webContents.isDestroyed()) {
            this.webContents.send(channel, ...args)
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

function waitForResponse<T> (channel: string): Promise<T> {
    return new Promise(resolve => {
        ipcMain.once(channel, (_event, ...args) => resolve(args.length === 1 ? args[0] : args as any))
    })
}

function keytarKey (profile: SSHProfile): string {
    return profile.options.port
        ? `ssh@${profile.options.host}:${profile.options.port}`
        : `ssh@${profile.options.host}`
}

async function loadPassword (profile: SSHProfile, username?: string): Promise<string | null> {
    const key = keytarKey(profile)
    const account = username ?? profile.options.user ?? ''
    try {
        return await keytar.getPassword(key, account)
    } catch {
        return null
    }
}

async function savePassword (profile: SSHProfile, password: string, username?: string): Promise<void> {
    const key = keytarKey(profile)
    const account = username ?? profile.options.user ?? ''
    try {
        await keytar.setPassword(key, account, password)
    } catch { /* ignore */ }
}

async function deletePassword (profile: SSHProfile, username?: string): Promise<void> {
    const key = keytarKey(profile)
    const account = username ?? profile.options.user ?? ''
    try {
        await keytar.deletePassword(key, account)
    } catch { /* ignore */ }
}

async function loadPrivateKeyPassword (keyHash: string): Promise<string | null> {
    try {
        return await keytar.getPassword('tabby-ssh-key-passphrase', keyHash)
    } catch {
        return null
    }
}

async function savePrivateKeyPassword (keyHash: string, passphrase: string): Promise<void> {
    try {
        await keytar.setPassword('tabby-ssh-key-passphrase', keyHash, passphrase)
    } catch { /* ignore */ }
}

async function deletePrivateKeyPassword (keyHash: string): Promise<void> {
    try {
        await keytar.deletePassword('tabby-ssh-key-passphrase', keyHash)
    } catch { /* ignore */ }
}

// Resolve X11 display spec to Socket connection options (inlined from x11.ts)
function resolveX11DisplaySpec (spec?: string | null): { path: string } | { host: string; port: number } {
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

function setupSocketChannelEvents (channel: russh.Channel, socket: Socket): void {
    channel.data$.subscribe({
        next: data => socket.write(data),
        error: () => socket.destroy(),
    })

    socket.on('data', data => {
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

// ── Agent spec builder ────────────────────────────────────────────────────────

async function getAgentConnectionSpec (
    profile: SSHProfile,
    emitServiceMessage: (msg: string) => void,
): Promise<russh.AgentConnectionSpec | null> {
    if (process.platform === 'win32') {
        const agentType = profile.options.agentType ?? 'auto'
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
                path: profile.options.agentPath || WINDOWS_OPENSSH_AGENT_PIPE,
            }
        }
    } else {
        const configuredPath = (profile.options.agentPath ?? '').trim()
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

// ── Key loading ───────────────────────────────────────────────────────────────

async function loadPrivateKey (
    sessionId: string,
    name: string,
    privateKeyContents: Uint8Array,
    state: SSHSessionState,
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
                state.send(`ssh:${sessionId}:need-passphrase`, keyHash)
                const [passVal, remember] = await waitForResponse<[string | null, boolean]>(`ssh:${sessionId}:passphrase-response`)
                if (!passVal) {
                    throw new Error('Passphrase prompt cancelled')
                }
                passphrase = passVal
                if (remember) {
                    await savePrivateKeyPassword(keyHash, passphrase)
                }
            } else {
                throw e
            }
        }
    }
}

// ── Auth loop ─────────────────────────────────────────────────────────────────

async function buildAuthMethods (
    sessionId: string,
    profile: SSHProfile,
    emitServiceMessage: (msg: string) => void,
): Promise<AuthMethod[]> {
    const methods: AuthMethod[] = [{ type: 'none' }]

    if (!profile.options.auth || profile.options.auth === 'publicKey') {
        const privateKeys = profile.options.privateKeys ?? []
        if (privateKeys.length) {
            for (let pk of privateKeys) {
                pk = pk.replace('%h', profile.options.host)
                pk = pk.replace('%r', profile.options.user ?? '')
                let contents: Uint8Array
                try {
                    contents = await fs.readFile(pk)
                } catch (error) {
                    emitServiceMessage(` ! Could not load private key ${pk}: ${error}`)
                    continue
                }

                // Skip .pub files mistakenly listed as private keys
                try {
                    russh.parsePublicKey(new TextDecoder().decode(contents))
                    emitServiceMessage(` ! Expected a private key, but ${pk} appears to be a public key. Skipping it.`)
                    continue
                } catch {
                    // Not a public key — this is a private key, proceed
                }

                methods.push({ type: 'publickey', name: pk, contents })
            }
        }
    }

    if (!profile.options.auth || profile.options.auth === 'agent') {
        const spec = await getAgentConnectionSpec(profile, emitServiceMessage)
        if (spec) {
            const privateKeys = profile.options.privateKeys ?? []
            if (privateKeys.length) {
                for (let pk of privateKeys) {
                    pk = pk.replace('%h', profile.options.host)
                    pk = pk.replace('%r', profile.options.user ?? '')
                    const pubKeyPath = pk.endsWith('.pub') ? pk : pk + '.pub'
                    try {
                        const pubKeyContent = await fs.readFile(pubKeyPath)
                        const publicKey = russh.parsePublicKey(new TextDecoder().decode(pubKeyContent))
                        methods.push({ type: 'agent', ...spec, publicKey } as AuthMethod)
                        emitServiceMessage(`Loaded public key for agent auth: ${pubKeyPath}`)
                    } catch (error) {
                        emitServiceMessage(`Could not load public key for agent auth from ${pubKeyPath}: ${error}`)
                    }
                }
            }
            methods.push({ type: 'agent', ...spec } as AuthMethod)
        }
    }

    if (!profile.options.auth || profile.options.auth === 'password') {
        if (profile.options.password) {
            methods.push({ type: 'saved-password', password: profile.options.password })
        }
    }

    if (!profile.options.auth || profile.options.auth === 'keyboardInteractive') {
        if (profile.options.password) {
            methods.push({ type: 'keyboard-interactive', savedPassword: profile.options.password })
        }
        methods.push({ type: 'keyboard-interactive' })
    }

    if (!profile.options.auth || profile.options.auth === 'password') {
        methods.push({ type: 'prompt-password' })
    }

    methods.push({ type: 'hostbased' })

    return methods
}

function populateStoredPasswords (
    methods: AuthMethod[],
    storedPassword: string,
    profile: SSHProfile,
): void {
    if (!profile.options.auth || profile.options.auth === 'password') {
        const hasSaved = methods.some(m => m.type === 'saved-password' && (m as any).password === storedPassword)
        if (!hasSaved) {
            const promptIndex = methods.findIndex(m => m.type === 'prompt-password')
            const insertIndex = promptIndex >= 0 ? promptIndex : methods.length
            methods.splice(insertIndex, 0, { type: 'saved-password', password: storedPassword })
        }
    }

    if (!profile.options.auth || profile.options.auth === 'keyboardInteractive') {
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

// eslint-disable-next-line max-statements
async function runAuthLoop (
    sessionId: string,
    profile: SSHProfile,
    state: SSHSessionState,
    allAuthMethods: AuthMethod[],
): Promise<russh.AuthenticatedSSHClient | null> {
    const ssh = state.ssh
    if (!(ssh instanceof russh.SSHClient)) {
        throw new Error('Wrong state for auth handling')
    }
    if (!state.authUsername) {
        throw new Error('No username')
    }

    const emitServiceMessage = (msg: string) => state.send(`ssh:${sessionId}:service-message`, msg)

    const noneResult = await ssh.authenticateNone(state.authUsername)
    if (noneResult instanceof russh.AuthenticatedSSHClient) {
        return noneResult
    }

    let remainingMethods = [...allAuthMethods]
    let methodsLeft = noneResult.remainingMethods

    function maybeSetRemainingMethods (r: russh.AuthFailure) {
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
            const storedPassword = await loadPassword(profile, state.authUsername)
            state.send(
                `ssh:${sessionId}:need-password`,
                state.authUsername,
                profile.options.host,
                !!storedPassword,
                storedPassword,
            )
            const [value, remember] = await waitForResponse<[string | null, boolean]>(`ssh:${sessionId}:password-response`)
            if (value == null) {
                continue
            }
            if (remember) {
                state.savedPassword = value
            }
            const result = await ssh.authenticateWithPassword(state.authUsername, value)
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
                if ((kiState as any).state === 'failure') {
                    maybeSetRemainingMethods(kiState as any)
                    break
                }

                if (kiState instanceof russh.AuthenticatedSSHClient) {
                    return kiState
                }

                const prompts = kiState.prompts()
                let responses: string[] = []

                if (prompts.length > 0) {
                    // Fill saved password into password prompts
                    const prefilledResponses: string[] = new Array(prompts.length).fill('')
                    if (method.savedPassword) {
                        for (let i = 0; i < prompts.length; i++) {
                            const p = prompts[i]
                            if (p.prompt.toLowerCase().includes('password') && !p.echo) {
                                prefilledResponses[i] = method.savedPassword
                            }
                        }
                    }

                    // Check if all password prompts are prefilled
                    const allPrefilled = prompts.every((p, i) =>
                        !(!p.echo && p.prompt.toLowerCase().includes('password')) || prefilledResponses[i] !== '',
                    )

                    if (allPrefilled && method.savedPassword) {
                        responses = prefilledResponses
                    } else {
                        state.send(
                            `ssh:${sessionId}:keyboard-interactive`,
                            kiState.name,
                            kiState.instructions,
                            prompts.map(p => ({ prompt: p.prompt, echo: p.echo })),
                        )
                        try {
                            responses = await waitForResponse<string[]>(`ssh:${sessionId}:ki-response`)
                        } catch {
                            break
                        }
                    }
                }

                kiState = await ssh.continueKeyboardInteractiveAuthentication(responses)
                if (kiState instanceof russh.AuthenticatedSSHClient) {
                    return kiState
                }
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

// ── Port forwarding helpers ───────────────────────────────────────────────────

async function startLocalForward (
    sessionId: string,
    fw: ForwardingConfig,
    state: SSHSessionState,
): Promise<Server> {
    const emitServiceMessage = (msg: string) => state.send(`ssh:${sessionId}:service-message`, msg)

    return new Promise((resolve, reject) => {
        const server = createServer(async socket => {
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

async function startDynamicForward (
    sessionId: string,
    fw: ForwardingConfig,
    state: SSHSessionState,
): Promise<Server> {
    const emitServiceMessage = (msg: string) => state.send(`ssh:${sessionId}:service-message`, msg)

    // Inline SOCKS5 dynamic forward without external dependency at this layer
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
        server['useAuth'](socksv5.auth.None())
    })
}

// ── SFTP lazy init ────────────────────────────────────────────────────────────

async function ensureSFTP (state: SSHSessionState): Promise<russh.SFTP> {
    if (state.sftp) {
        return state.sftp
    }
    if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
        throw new Error('Cannot open SFTP before authentication')
    }
    state.sftp = await state.ssh.activateSFTP(await state.ssh.openSessionChannel())
    return state.sftp
}

// ── Connect flow ──────────────────────────────────────────────────────────────

// eslint-disable-next-line max-statements
async function connectSession (
    sessionId: string,
    profile: SSHProfile,
    state: SSHSessionState,
): Promise<void> {
    const emitServiceMessage = (msg: string) => state.send(`ssh:${sessionId}:service-message`, msg)

    // 1. Build transport
    let transport: russh.SshTransport
    if (profile.options.proxyCommand) {
        emitServiceMessage(` Proxy command: using ${profile.options.proxyCommand}`)
        const argv = profile.options.proxyCommand.split(/\s+/)
        transport = await russh.SshTransport.newCommand(argv[0], argv.slice(1))
    } else if (profile.jumpChannelId) {
        const jumpChannel = jumpChannels.get(profile.jumpChannelId)
        if (!jumpChannel) {
            throw new Error(`Jump channel not found: ${profile.jumpChannelId}`)
        }
        jumpChannels.delete(profile.jumpChannelId)
        transport = await russh.SshTransport.newSshChannel(jumpChannel.take())
    } else if (profile.options.socksProxyHost) {
        emitServiceMessage(` Proxy: using SOCKS ${profile.options.socksProxyHost}:${profile.options.socksProxyPort}`)
        transport = await russh.SshTransport.newSocksProxy(
            profile.options.socksProxyHost,
            profile.options.socksProxyPort ?? 1080,
            profile.options.host,
            profile.options.port ?? 22,
        )
    } else if (profile.options.httpProxyHost) {
        emitServiceMessage(` Proxy: using HTTP ${profile.options.httpProxyHost}:${profile.options.httpProxyPort}`)
        transport = await russh.SshTransport.newHttpProxy(
            profile.options.httpProxyHost,
            profile.options.httpProxyPort ?? 8080,
            profile.options.host,
            profile.options.port ?? 22,
        )
    } else {
        transport = await russh.SshTransport.newSocket(`${profile.options.host.trim()}:${profile.options.port ?? 22}`)
    }

    // 2. Connect with host key verification
    state.ssh = await russh.SSHClient.connect(
        transport,
        async (key: russh.SshPublicKey) => {
            const algo = key.algorithm()
            const fingerprint = key.fingerprint()
            const digest = crypto.createHash('sha256').update(key.bytes()).digest('base64')
            state.send(`ssh:${sessionId}:host-key-verify`, algo, fingerprint, digest)
            const accepted = await waitForResponse<boolean>(`ssh:${sessionId}:host-key-response`)
            return accepted
        },
        {
            keepaliveIntervalSeconds: profile.options.keepaliveInterval
                ? Math.round(profile.options.keepaliveInterval / 1000)
                : undefined,
            keepaliveCountMax: profile.options.keepaliveCountMax,
            connectionTimeoutSeconds: profile.options.readyTimeout
                ? Math.round(profile.options.readyTimeout / 1000)
                : undefined,
        },
    )

    // 3. Disconnect subscription
    state.ssh.disconnect$.subscribe(() => {
        if (!state.previouslyDisconnected) {
            state.previouslyDisconnected = true
            setTimeout(() => {
                state.send(`ssh:${sessionId}:close`)
                cleanupSession(sessionId, state)
            })
        }
    })

    // 4. Banner subscription
    if (!profile.options.skipBanner) {
        state.ssh.banner$.subscribe((banner: string) => {
            emitServiceMessage(banner)
        })
    }

    // 5. Determine username
    state.authUsername = profile.options.user ?? null
    if (!state.authUsername) {
        state.send(`ssh:${sessionId}:need-username`, profile.options.host)
        state.authUsername = await waitForResponse<string>(`ssh:${sessionId}:username-response`)
    }

    if (state.authUsername?.startsWith('$')) {
        state.authUsername = process.env[state.authUsername.slice(1)] ?? state.authUsername
    }

    // 6. Build auth methods
    const allAuthMethods = await buildAuthMethods(sessionId, profile, emitServiceMessage)

    // 7. Populate stored passwords
    const storedPassword = await loadPassword(profile, state.authUsername)
    if (storedPassword) {
        populateStoredPasswords(allAuthMethods, storedPassword, profile)
    }

    // 8. Run auth loop
    const authSub = state.ssh.disconnect$.subscribe(() => {
        const publicKeyCount = allAuthMethods.filter(m => m.type === 'publickey').length
        if (!profile.options.auth && publicKeyCount >= 3) {
            emitServiceMessage('The server has disconnected during authentication.')
            emitServiceMessage('This may happen if too many private key authentication attempts are made.')
            emitServiceMessage('You can set the specific private key for authentication in the profile settings.')
        }
    })

    let authenticatedClient: russh.AuthenticatedSSHClient | null
    try {
        authenticatedClient = await runAuthLoop(sessionId, profile, state, allAuthMethods)
    } finally {
        authSub.unsubscribe()
    }

    if (!authenticatedClient) {
        state.ssh.disconnect()
        await deletePassword(profile, state.authUsername)
        throw new Error('Authentication rejected')
    }

    state.ssh = authenticatedClient

    // Save password if user asked to remember
    if (state.savedPassword) {
        await savePassword(profile, state.savedPassword, state.authUsername)
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
        const displaySpec = (profile.options.x11Display || process.env.DISPLAY) ?? 'localhost:0'
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
        const spec = await getAgentConnectionSpec(profile, emitServiceMessage)
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
}

function cleanupSession (sessionId: string, state: SSHSessionState): void {
    for (const fp of state.forwardedPorts) {
        fp.listener?.close()
    }
    state.forwardedPorts = []
    state.sftp = null
    state.shell = null
    state.ssh = null
}

// ── Main export ───────────────────────────────────────────────────────────────

export function initSSH (app: Application): void {
    const sessions = new Map<string, SSHSessionState>()
    const jumpChannels = new Map<string, russh.NewChannel>()

    function getState (sessionId: string): SSHSessionState {
        const s = sessions.get(sessionId)
        if (!s) throw new Error(`No SSH session: ${sessionId}`)
        return s
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    ipcMain.removeHandler('ssh:session:open-jump-channel')
    ipcMain.handle('ssh:session:open-jump-channel', async (_event, sourceSessionId: string, host: string, port: number) => {
        const state = getState(sourceSessionId)
        if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('Jump session is not authenticated')
        }
        const newChannel = await state.ssh.openTCPForwardChannel({
            addressToConnectTo: host,
            portToConnectTo: port,
            originatorAddress: '127.0.0.1',
            originatorPort: 0,
        })
        const jumpChannelId = uuidv4()
        jumpChannels.set(jumpChannelId, newChannel)
        return jumpChannelId
    })

    ipcMain.removeHandler('ssh:session:connect')
    ipcMain.handle('ssh:session:connect', async (event, sessionId: string, profile: SSHProfile) => {
        const state = new SSHSessionState(event.sender)
        sessions.set(sessionId, state)
        try {
            await connectSession(sessionId, profile, state)
        } catch (err) {
            sessions.delete(sessionId)
            throw err
        }
    })

    ipcMain.removeHandler('ssh:session:open-shell')
    ipcMain.handle('ssh:session:open-shell', async (_event, sessionId: string, x11: boolean) => {
        const state = getState(sessionId)
        if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('Cannot open shell before authentication')
        }
        const ch = await state.ssh.activateChannel(await state.ssh.openSessionChannel())
        await ch.requestPTY('xterm-256color', { columns: 80, rows: 24, pixHeight: 0, pixWidth: 0 })
        if (x11) {
            await ch.requestX11Forwarding({
                singleConnection: false,
                authProtocol: 'MIT-MAGIC-COOKIE-1',
                authCookie: crypto.randomBytes(16).toString('hex'),
                screenNumber: 0,
            })
        }
        state.shell = ch

        ch.data$.subscribe((data: Buffer) => {
            state.send(`ssh:${sessionId}:data`, data)
        })
        ch.closed$.subscribe(() => {
            state.send(`ssh:${sessionId}:shell-close`)
        })
        ch.eof$.subscribe(() => {
            state.send(`ssh:${sessionId}:shell-close`)
        })

        await ch.requestShell()
    })

    ipcMain.on('ssh:session:shell-write', (_event, sessionId: string, data: Uint8Array) => {
        const state = sessions.get(sessionId)
        if (state?.shell) {
            state.shell.write(data)
        }
    })

    ipcMain.on('ssh:session:shell-resize', (_event, sessionId: string, cols: number, rows: number) => {
        const state = sessions.get(sessionId)
        if (state?.shell) {
            state.shell.resizePTY({ columns: cols, rows, pixWidth: 0, pixHeight: 0 })
        }
    })

    ipcMain.removeHandler('ssh:session:destroy')
    ipcMain.handle('ssh:session:destroy', async (_event, sessionId: string) => {
        const state = sessions.get(sessionId)
        if (!state) return
        cleanupSession(sessionId, state)
        state.ssh?.disconnect()
        sessions.delete(sessionId)
    })

    // ── SFTP ──────────────────────────────────────────────────────────────────

    ipcMain.removeHandler('ssh:session:sftp-readdir')
    ipcMain.handle('ssh:session:sftp-readdir', async (_event, sessionId: string, path: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        return sftp.readdir(path)
    })

    ipcMain.removeHandler('ssh:session:sftp-stat')
    ipcMain.handle('ssh:session:sftp-stat', async (_event, sessionId: string, path: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        return sftp.stat(path)
    })

    ipcMain.removeHandler('ssh:session:sftp-readlink')
    ipcMain.handle('ssh:session:sftp-readlink', async (_event, sessionId: string, path: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        return sftp.readlink(path)
    })

    ipcMain.removeHandler('ssh:session:sftp-open')
    ipcMain.handle('ssh:session:sftp-open', async (_event, sessionId: string, path: string, mode: any) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        const handle = await sftp.open(path, mode)
        const handleId = uuidv4()
        state.sftpHandles.set(handleId, handle)
        return handleId
    })

    ipcMain.removeHandler('ssh:session:sftp-read')
    ipcMain.handle('ssh:session:sftp-read', async (_event, sessionId: string, handleId: string, length: number) => {
        const state = getState(sessionId)
        const handle = state.sftpHandles.get(handleId)
        if (!handle) throw new Error(`Invalid SFTP handle: ${handleId}`)
        return handle.read(length)
    })

    ipcMain.removeHandler('ssh:session:sftp-write')
    ipcMain.handle('ssh:session:sftp-write', async (_event, sessionId: string, handleId: string, data: Uint8Array) => {
        const state = getState(sessionId)
        const handle = state.sftpHandles.get(handleId)
        if (!handle) throw new Error(`Invalid SFTP handle: ${handleId}`)
        await handle.write(data)
    })

    ipcMain.removeHandler('ssh:session:sftp-close')
    ipcMain.handle('ssh:session:sftp-close', async (_event, sessionId: string, handleId: string) => {
        const state = getState(sessionId)
        const handle = state.sftpHandles.get(handleId)
        if (!handle) throw new Error(`Invalid SFTP handle: ${handleId}`)
        await handle.close()
        state.sftpHandles.delete(handleId)
    })

    ipcMain.removeHandler('ssh:session:sftp-rmdir')
    ipcMain.handle('ssh:session:sftp-rmdir', async (_event, sessionId: string, path: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        await sftp.rmdir(path)
    })

    ipcMain.removeHandler('ssh:session:sftp-mkdir')
    ipcMain.handle('ssh:session:sftp-mkdir', async (_event, sessionId: string, path: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        await sftp.mkdir(path)
    })

    ipcMain.removeHandler('ssh:session:sftp-rename')
    ipcMain.handle('ssh:session:sftp-rename', async (_event, sessionId: string, oldPath: string, newPath: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        await sftp.rename(oldPath, newPath)
    })

    ipcMain.removeHandler('ssh:session:sftp-unlink')
    ipcMain.handle('ssh:session:sftp-unlink', async (_event, sessionId: string, path: string) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        await sftp.unlink(path)
    })

    ipcMain.removeHandler('ssh:session:sftp-chmod')
    ipcMain.handle('ssh:session:sftp-chmod', async (_event, sessionId: string, path: string, mode: number) => {
        const state = getState(sessionId)
        const sftp = await ensureSFTP(state)
        await sftp.setstat(path, { permissions: mode })
    })

    // ── Port forwarding ───────────────────────────────────────────────────────

    ipcMain.removeHandler('ssh:session:forward-add')
    ipcMain.handle('ssh:session:forward-add', async (_event, sessionId: string, fw: ForwardingConfig) => {
        const state = getState(sessionId)
        const emitServiceMessage = (msg: string) => state.send(`ssh:${sessionId}:service-message`, msg)

        if (fw.type === 'Local') {
            const server = await startLocalForward(sessionId, fw, state)
            state.forwardedPorts.push({ config: fw, listener: server })
        } else if (fw.type === 'Dynamic') {
            const server = await startDynamicForward(sessionId, fw, state)
            state.forwardedPorts.push({ config: fw, listener: server })
        } else if (fw.type === 'Remote') {
            if (!(state.ssh instanceof russh.AuthenticatedSSHClient)) {
                throw new Error('Cannot add remote port forward before authentication')
            }
            try {
                await state.ssh.forwardTCPPort(fw.host, fw.port)
                emitServiceMessage(` <- Forwarded (remote) ${fw.host}:${fw.port} -> ${fw.targetAddress}:${fw.targetPort}`)
                state.forwardedPorts.push({ config: fw, listener: null })
            } catch (err) {
                emitServiceMessage(` X Remote rejected port forwarding for ${fw.host}:${fw.port}: ${err}`)
                throw err
            }
        }
    })

    ipcMain.removeHandler('ssh:session:forward-remove')
    ipcMain.handle('ssh:session:forward-remove', async (_event, sessionId: string, fw: ForwardingConfig) => {
        const state = getState(sessionId)
        const emitServiceMessage = (msg: string) => state.send(`ssh:${sessionId}:service-message`, msg)

        const entry = state.forwardedPorts.find(
            f => f.config.type === fw.type && f.config.host === fw.host && f.config.port === fw.port,
        )
        if (!entry) return

        if (fw.type === 'Local' || fw.type === 'Dynamic') {
            entry.listener?.close()
        } else if (fw.type === 'Remote') {
            if (state.ssh instanceof russh.AuthenticatedSSHClient) {
                state.ssh.stopForwardingTCPPort(fw.host, fw.port)
            }
        }

        state.forwardedPorts = state.forwardedPorts.filter(f => f !== entry)
        emitServiceMessage(`Stopped forwarding ${fw.type} ${fw.host}:${fw.port}`)
    })
}
