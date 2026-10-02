// Derived from: tabby-ssh/src/session/ssh.ts
import colors from 'ansi-colors'
import stripAnsi from 'strip-ansi'
import { Injector } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, FileProvidersService, PromptModalComponent, LogService, Logger } from 'tabby-core'
import { Subject, Observable } from 'rxjs'
import { HostKeyPromptModalComponent } from '../components/hostKeyPromptModal.component'
import { PasswordStorageService } from '../services/passwordStorage.service'
import { SSHKnownHostsService } from '../services/sshKnownHosts.service'
import { SFTPSession } from './sftp'
import { SSHAlgorithmType, AutoPrivateKeyLocator, PortForwardType } from '../api'
import type { SSHProfile } from '../api'
import { ForwardedPort } from './forwards'
import { supportedAlgorithms } from '../algorithms'
import { ipc } from '@gen/ipc'

export interface Prompt {
    prompt: string
    echo?: boolean
}

export class KeyboardInteractivePrompt {
    readonly responses: string[] = []

    private _resolve!: (value: string[]) => void
    private _reject!: (reason: unknown) => void
    readonly promise = new Promise<string[]>((resolve, reject) => {
        this._resolve = resolve
        this._reject = reject
    })

    constructor (
        public name: string,
        public instruction: string,
        public prompts: Prompt[],
    ) {
        this.responses = new Array(this.prompts.length).fill('')
    }

    isAPasswordPrompt (index: number): boolean {
        return this.prompts[index].prompt.toLowerCase().includes('password') && !this.prompts[index].echo
    }

    respond (): void {
        this._resolve(this.responses)
    }

    reject (): void {
        this._reject(new Error('Keyboard-interactive auth rejected'))
    }
}

export class ShellChannelProxy {
    data$ = new Subject<Uint8Array>()
    eof$ = new Subject<void>()
    private sub: { unsubscribe(): void } | null = null

    constructor (private sessionId: string, x11: boolean) {
        const stream = ipc.ssh.OpenShell({ sessionId, x11 })
        this.sub = stream.subscribe({
            next: (ev) => {
                if (ev.closed) {
                    this.eof$.next()
                } else if (ev.data?.length) {
                    this.data$.next(ev.data)
                }
            },
            error: () => { this.eof$.next() },
            complete: () => { this.eof$.next() },
        })
    }

    write (data: Uint8Array): void {
        ipc.ssh.WriteShell({ sessionId: this.sessionId, data }).catch(() => {})
    }

    resizePTY (dims: { columns: number; rows: number; pixWidth: number; pixHeight: number }): void {
        ipc.ssh.ResizeShell({ sessionId: this.sessionId, cols: dims.columns, rows: dims.rows }).catch(() => {})
    }

    close (): void {
        this.sub?.unsubscribe()
        this.sub = null
        this.data$.complete()
        this.eof$.complete()
    }
}

export class SSHSession {
    sessionId = window.crypto.randomUUID()
    activePrivateKey: null = null
    authUsername: string | null = null
    jumpChannelId: string | null = null
    open = false

    forwardedPorts: ForwardedPort[] = []

    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    get keyboardInteractivePrompt$ (): Observable<KeyboardInteractivePrompt> { return this.keyboardInteractivePrompt }
    get willDestroy$ (): Observable<void> { return this.willDestroy }

    private logger: Logger
    private refCount = 0
    private serviceMessage = new Subject<string>()
    private keyboardInteractivePrompt = new Subject<KeyboardInteractivePrompt>()
    private willDestroy = new Subject<void>()
    private sessionClose$ = new Subject<void>()

    private connectSub: { unsubscribe(): void } | null = null

    private passwordStorage: PasswordStorageService
    private ngbModal: NgbModal
    private fileProviders: FileProvidersService
    private config: ConfigService
    private knownHosts: SSHKnownHostsService
    private privateKeyImporters: AutoPrivateKeyLocator[]

    constructor (
        private injector: Injector,
        public profile: SSHProfile,
    ) {
        this.logger = injector.get(LogService).create(`ssh-${profile.options.host}-${profile.options.port}`)

        this.passwordStorage = injector.get(PasswordStorageService)
        this.ngbModal = injector.get(NgbModal)
        this.fileProviders = injector.get(FileProvidersService)
        this.config = injector.get(ConfigService)
        this.knownHosts = injector.get(SSHKnownHostsService)
        this.privateKeyImporters = injector.get(AutoPrivateKeyLocator, [])

        this.willDestroy$.subscribe(() => {
            for (const port of this.forwardedPorts) {
                port.stopLocalListener()
            }
        })
    }

    private async loadPrivateKeys (): Promise<Array<{ name: string; contents: Uint8Array }>> {
        const keys: Array<{ name: string; contents: Uint8Array }> = []

        if (!this.profile.options.auth || this.profile.options.auth === 'publicKey') {
            if (this.profile.options.privateKeys.length) {
                for (let pk of this.profile.options.privateKeys) {
                    pk = pk.replace('%h', this.profile.options.host)
                    pk = pk.replace('%r', this.profile.options.user)
                    let contents: Uint8Array
                    try {
                        contents = await this.fileProviders.retrieveFile(pk)
                    } catch (error) {
                        this.emitServiceMessage(colors.bgYellow.yellow.black(' ! ') + ` Could not load private key ${pk}: ${error}`)
                        continue
                    }

                    const text = new TextDecoder().decode(contents)
                    if (text.includes('PUBLIC KEY') && !text.includes('PRIVATE')) {
                        this.emitServiceMessage(
                            colors.bgYellow.yellow.black(' ! ') +
                            ` Expected a private key, but ${pk} appears to be a public key. Skipping it for private key authentication.`,
                        )
                        continue
                    }

                    keys.push({ name: pk, contents })
                }
            } else {
                for (const importer of this.privateKeyImporters) {
                    for (const [name, contents] of await importer.getKeys()) {
                        keys.push({ name, contents: new Uint8Array(contents) })
                    }
                }
            }
        }

        return keys
    }

    private buildConnectRequest (privateKeys: Array<{ name: string; contents: Uint8Array }>): import('@gen/ssh').SshConnectRequest {
        const opts = this.profile.options

        const filterAlgorithms = (type: SSHAlgorithmType): string[] =>
            (opts.algorithms[type] ?? []).filter(x => supportedAlgorithms[type].includes(x))

        const authMap: Record<string, string> = {
            publicKey: 'publicKey',
            password: 'password',
            agent: 'agent',
            keyboardInteractive: 'keyboardInteractive',
        }
        const auth = opts.auth ? (authMap[opts.auth] ?? '') : ''

        return {
            sessionId: this.sessionId,
            host: opts.host,
            port: opts.port ?? 22,
            user: opts.user,
            auth,
            password: opts.password ?? '',
            privateKeys,
            keepaliveIntervalMs: opts.keepaliveInterval ?? 0,
            keepaliveCountMax: opts.keepaliveCountMax ?? 3,
            readyTimeoutMs: opts.readyTimeout ?? 0,
            x11: opts.x11 ?? false,
            agentForward: opts.agentForward ?? false,
            skipBanner: opts.skipBanner ?? false,
            proxyCommand: opts.proxyCommand ?? '',
            socksProxyHost: opts.socksProxyHost ?? '',
            socksProxyPort: opts.socksProxyPort ?? 0,
            httpProxyHost: opts.httpProxyHost ?? '',
            httpProxyPort: opts.httpProxyPort ?? 0,
            agentType: this.config.store.ssh?.agentType ?? '',
            agentPath: this.config.store.ssh?.agentPath ?? '',
            x11Display: this.config.store.ssh?.x11Display ?? '',
            jumpChannelId: this.jumpChannelId ?? '',
            kexAlgorithms: filterAlgorithms(SSHAlgorithmType.KEX),
            cipherAlgorithms: filterAlgorithms(SSHAlgorithmType.CIPHER),
            hmacAlgorithms: filterAlgorithms(SSHAlgorithmType.HMAC),
            hostKeyAlgorithms: filterAlgorithms(SSHAlgorithmType.HOSTKEY),
            compressionAlgorithms: filterAlgorithms(SSHAlgorithmType.COMPRESSION),
        }
    }

    private async handleSessionEvent (
        event: { type: string; serviceMessageText: string; hostKeyChallenge?: { algo: string; fingerprint: string; digest: string }; usernameChallenge?: { host: string }; passwordChallenge?: { username: string; host: string; hasStoredPassword: boolean; storedPassword: string }; passphraseChallenge?: { keyHash: string }; kiChallenge?: { name: string; instructions: string; prompts: Array<{ prompt: string; echo: boolean }> }; connected?: { authUsername: string }; disconnected?: { reason: string } },
        resolve: () => void,
        reject: (err: unknown) => void,
    ): Promise<void> {
        switch (event.type) {
            case 'host_key_challenge': {
                const hkc = event.hostKeyChallenge
                if (!hkc) {
                    break
                }
                this.emitServiceMessage('Host key fingerprint:')
                this.emitServiceMessage(colors.white.bgBlack(` ${hkc.algo} `) + colors.bgBlackBright(' ' + hkc.fingerprint + ' '))

                let accepted = true
                if (this.config.store.ssh?.verifyHostKeys) {
                    const selector = {
                        host: this.profile.options.host,
                        port: this.profile.options.port ?? 22,
                        type: hkc.algo,
                    }
                    const knownHost = this.profile.options.host ? this.knownHosts.getFor(selector) : null
                    if (!knownHost || knownHost.digest !== hkc.digest) {
                        const modal = this.ngbModal.open(HostKeyPromptModalComponent)
                        modal.componentInstance.selector = selector
                        modal.componentInstance.digest = hkc.digest
                        accepted = await modal.result.catch(() => false)
                    }
                }

                ipc.ssh.RespondHostKey({ sessionId: this.sessionId, accepted }).catch(() => {})
                break
            }
            case 'username_challenge': {
                let username = this.profile.options.user ?? ''
                if (!username) {
                    const modal = this.ngbModal.open(PromptModalComponent)
                    modal.componentInstance.prompt = `Username for ${event.usernameChallenge?.host ?? this.profile.options.host}`
                    const result = await modal.result.catch(() => null)
                    username = result?.value ?? 'root'
                }
                if (username.startsWith('$')) {
                    // Cannot access process.env in renderer; send as-is
                }
                this.authUsername = username
                ipc.ssh.RespondUsername({ sessionId: this.sessionId, username }).catch(() => {})
                break
            }
            case 'password_challenge': {
                const pwc = event.passwordChallenge
                let password: string | null = null
                if (pwc?.hasStoredPassword && pwc.storedPassword) {
                    password = pwc.storedPassword
                } else {
                    const storedPassword = this.authUsername
                        ? await this.passwordStorage.loadPassword(this.profile, this.authUsername)
                        : null
                    if (storedPassword) {
                        password = storedPassword
                    } else {
                        const modal = this.ngbModal.open(PromptModalComponent)
                        modal.componentInstance.prompt = `Password for ${pwc?.username ?? this.authUsername ?? ''}@${pwc?.host ?? this.profile.options.host}`
                        modal.componentInstance.password = true
                        modal.componentInstance.showRememberCheckbox = true
                        const promptResult = await modal.result.catch(() => null)
                        if (promptResult) {
                            password = promptResult.value
                            if (promptResult.remember && password) {
                                await this.passwordStorage.savePassword(this.profile, password, this.authUsername ?? undefined)
                            }
                        }
                    }
                }
                ipc.ssh.RespondPassword({ sessionId: this.sessionId, password: password ?? '', remember: false }).catch(() => {})
                break
            }
            case 'passphrase_challenge': {
                const phc = event.passphraseChallenge
                const keyHash = phc?.keyHash ?? ''
                let passphrase: string | null = null

                passphrase = await this.passwordStorage.loadPrivateKeyPassword(keyHash)
                if (!passphrase) {
                    const modal = this.ngbModal.open(PromptModalComponent)
                    modal.componentInstance.prompt = 'Private key passphrase'
                    modal.componentInstance.password = true
                    modal.componentInstance.showRememberCheckbox = true
                    const result = await modal.result.catch(() => null)
                    if (result?.value) {
                        passphrase = result.value as string
                        if (result.remember) {
                            this.passwordStorage.savePrivateKeyPassword(keyHash, passphrase)
                        }
                    }
                }
                ipc.ssh.RespondPassphrase({ sessionId: this.sessionId, passphrase: passphrase ?? '', remember: false }).catch(() => {})
                break
            }
            case 'ki_challenge': {
                const kic = event.kiChallenge
                if (!kic) {
                    ipc.ssh.RespondKi({ sessionId: this.sessionId, responses: [] }).catch(() => {})
                    break
                }
                const prompt = new KeyboardInteractivePrompt(
                    kic.name,
                    kic.instructions,
                    kic.prompts.map(p => ({ prompt: p.prompt, echo: p.echo })),
                )
                this.emitKeyboardInteractivePrompt(prompt)
                try {
                    const responses = await prompt.promise
                    ipc.ssh.RespondKi({ sessionId: this.sessionId, responses }).catch(() => {})
                } catch {
                    ipc.ssh.RespondKi({ sessionId: this.sessionId, responses: [] }).catch(() => {})
                }
                break
            }
            case 'service_message': {
                this.emitServiceMessage(event.serviceMessageText)
                break
            }
            case 'connected': {
                this.authUsername = event.connected?.authUsername ?? null
                this.open = true

                for (const fw of this.profile.options.forwardedPorts) {
                    await this.addPortForward(Object.assign(new ForwardedPort(), fw))
                }

                resolve()
                break
            }
            case 'disconnected': {
                if (!this.open) {
                    reject(new Error(`SSH disconnected before connecting: ${event.disconnected?.reason ?? 'unknown reason'}`))
                } else {
                    this.destroy()
                }
                break
            }
        }
    }

    async start (): Promise<void> {
        const privateKeys = await this.loadPrivateKeys()
        const request = this.buildConnectRequest(privateKeys)

        return new Promise<void>((resolve, reject) => {
            const stream = ipc.ssh.Connect(request)
            this.connectSub = stream.subscribe({
                next: (event) => {
                    void this.handleSessionEvent(event, resolve, reject)
                },
                error: (err) => {
                    if (!this.open) {
                        reject(err)
                    } else {
                        this.destroy()
                    }
                },
                complete: () => {
                    if (!this.open) {
                        reject(new Error('SSH connection closed before connecting'))
                    } else {
                        this.destroy()
                    }
                },
            })
        })
    }

    openSFTP (): SFTPSession {
        return new SFTPSession(this.sessionId, this.injector, this.sessionClose$.asObservable())
    }

    openShellChannel (options: { x11: boolean }): ShellChannelProxy {
        return new ShellChannelProxy(this.sessionId, options.x11)
    }

    async addPortForward (fw: ForwardedPort): Promise<void> {
        if (fw.type === PortForwardType.Local || fw.type === PortForwardType.Dynamic) {
            await fw.startLocalListener(async () => {
                // Port forwarding is handled in main process
            }).then(() => {
                this.emitServiceMessage(colors.bgGreen.black(' -> ') + ` Forwarded ${fw}`)
                this.forwardedPorts.push(fw)
            }).catch(e => {
                this.emitServiceMessage(colors.bgRed.black(' X ') + ` Failed to forward port ${fw}: ${e}`)
            })
        }

        if (fw.type === PortForwardType.Remote) {
            try {
                await ipc.ssh.AddPortForward({
                    sessionId: this.sessionId,
                    type: 'remote',
                    host: fw.host,
                    port: fw.port,
                    targetAddress: fw.targetAddress,
                    targetPort: fw.targetPort,
                })
                this.emitServiceMessage(colors.bgGreen.black(' <- ') + ` Forwarded ${fw}`)
                this.forwardedPorts.push(fw)
            } catch (err) {
                this.emitServiceMessage(colors.bgRed.black(' X ') + ` Remote rejected port forwarding for ${fw}: ${err}`)
            }
        }

        if (fw.type === PortForwardType.Local) {
            try {
                await ipc.ssh.AddPortForward({
                    sessionId: this.sessionId,
                    type: 'local',
                    host: fw.host,
                    port: fw.port,
                    targetAddress: fw.targetAddress,
                    targetPort: fw.targetPort,
                })
            } catch (err) {
                this.emitServiceMessage(colors.bgRed.black(' X ') + ` Failed to request local port forward ${fw}: ${err}`)
            }
        }
    }

    async removePortForward (fw: ForwardedPort): Promise<void> {
        if (fw.type === PortForwardType.Local || fw.type === PortForwardType.Dynamic) {
            fw.stopLocalListener()
            this.forwardedPorts = this.forwardedPorts.filter(x => x !== fw)
        }
        if (fw.type === PortForwardType.Remote) {
            await ipc.ssh.RemovePortForward({
                sessionId: this.sessionId,
                type: 'remote',
                host: fw.host,
                port: fw.port,
                targetAddress: '',
                targetPort: 0,
            }).catch(() => {})
            this.forwardedPorts = this.forwardedPorts.filter(x => x !== fw)
        }
        this.emitServiceMessage(`Stopped forwarding ${fw}`)
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    emitKeyboardInteractivePrompt (prompt: KeyboardInteractivePrompt): void {
        this.logger.info('Keyboard-interactive auth:', prompt.name, prompt.instruction)
        this.emitServiceMessage(colors.bgBlackBright(' ') + ` Keyboard-interactive auth requested: ${prompt.name}`)
        if (prompt.instruction) {
            for (const line of prompt.instruction.split('\n')) {
                this.emitServiceMessage(line)
            }
        }
        this.keyboardInteractivePrompt.next(prompt)
    }

    ref (): void {
        this.refCount++
    }

    unref (): void {
        this.refCount--
        if (this.refCount === 0) {
            this.destroy()
        }
    }

    destroy (): void {
        this.logger.info('Destroying')
        this.connectSub?.unsubscribe()
        this.connectSub = null
        ipc.ssh.Destroy({ sessionId: this.sessionId }).catch(() => {})
        this.sessionClose$.next()
        this.sessionClose$.complete()
        this.willDestroy.next()
        this.willDestroy.complete()
        this.serviceMessage.complete()
    }
}
