import colors from 'ansi-colors'
import stripAnsi from 'strip-ansi'
import { Injector } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, NotificationsService, PromptModalComponent, LogService, Logger } from 'tabby-core'
import { Subject, Observable } from 'rxjs'
import { HostKeyPromptModalComponent } from '../components/hostKeyPromptModal.component'
import { SSHKnownHostsService } from '../services/sshKnownHosts.service'
import { SFTPSession } from './sftp'
import { PortForwardType, SSHProfile } from '../api'
import { ForwardedPort } from './forwards'

export interface Prompt {
    prompt: string
    echo?: boolean
}

export class KeyboardInteractivePrompt {
    readonly responses: string[] = []

    private _resolve: (value: string[]) => void
    private _reject: (reason: any) => void
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
    data$: Subject<Uint8Array>
    eof$: Subject<void>
    private unsubData: (() => void) | null = null
    private unsubClose: (() => void) | null = null

    constructor (private sessionId: string, ipc: any) {
        this.data$ = new Subject<Uint8Array>()
        this.eof$ = new Subject<void>()
        this.unsubData = ipc.on(`ssh:${sessionId}:data`, (data: Uint8Array) => {
            this.data$.next(data)
        })
        this.unsubClose = ipc.on(`ssh:${sessionId}:shell-close`, () => {
            this.eof$.next()
        })
    }

    write (data: Uint8Array): void {
        ;(window as any).tabbyAPI.ipc.send('ssh:session:shell-write', this.sessionId, data)
    }

    resizePTY (dims: { columns: number; rows: number; pixWidth: number; pixHeight: number }): void {
        ;(window as any).tabbyAPI.ipc.send('ssh:session:shell-resize', this.sessionId, dims.columns, dims.rows)
    }

    close (): void {
        this.unsubData?.()
        this.unsubClose?.()
        this.data$.complete()
        this.eof$.complete()
        this.unsubData = null
        this.unsubClose = null
    }
}

export class SSHSession {
    readonly sessionId: string
    forwardedPorts: ForwardedPort[] = []
    jumpChannelId: string | null = null
    open = false

    /** @deprecated Legacy compat stub — username is resolved by the main process */
    authUsername: string | null = null
    /** @deprecated Legacy compat stub — private key loading is handled by the main process */
    activePrivateKey: null = null

    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    get keyboardInteractivePrompt$ (): Observable<KeyboardInteractivePrompt> { return this.keyboardInteractivePrompt }
    get willDestroy$ (): Observable<void> { return this.willDestroy }

    private serviceMessage = new Subject<string>()
    private keyboardInteractivePrompt = new Subject<KeyboardInteractivePrompt>()
    private willDestroy = new Subject<void>()
    private sessionClose$ = new Subject<void>()
    private logger: Logger
    private refCount = 0
    private unsubscribers: Array<() => void> = []
    private shell: ShellChannelProxy | null = null
    private destroyed = false

    private ngbModal: NgbModal
    private notifications: NotificationsService
    private knownHosts: SSHKnownHostsService
    private config: ConfigService

    constructor (
        private injector: Injector,
        public profile: SSHProfile,
    ) {
        this.sessionId = window.crypto.randomUUID()
        this.logger = injector.get(LogService).create(`ssh-${profile.options.host}-${profile.options.port}`)
        this.ngbModal = injector.get(NgbModal)
        this.notifications = injector.get(NotificationsService)
        this.knownHosts = injector.get(SSHKnownHostsService)
        this.config = injector.get(ConfigService)

        this.willDestroy$.subscribe(() => {
            for (const port of this.forwardedPorts) {
                port.stopLocalListener()
            }
        })
    }

    private serializeProfile (): any {
        return {
            ...this.profile,
            jumpChannelId: this.jumpChannelId,
        }
    }

    async start (): Promise<void> {
        const ipc = (window as any).tabbyAPI.ipc
        const id = this.sessionId
        const profile = this.profile

        // Host key verification
        const unsubHostKey = ipc.on(`ssh:${id}:host-key-verify`, async (algo: string, fingerprint: string, digest: string) => {
            this.emitServiceMessage('Host key fingerprint:')
            this.emitServiceMessage(colors.white.bgBlack(` ${algo} `) + colors.bgBlackBright(' ' + fingerprint + ' '))

            if (!this.config.store.ssh.verifyHostKeys) {
                ipc.send(`ssh:${id}:host-key-response`, true)
                return
            }

            const selector = {
                host: profile.options.host,
                port: profile.options.port ?? 22,
                type: algo,
            }
            const knownHost = profile.options.host ? this.knownHosts.getFor(selector) : null

            if (knownHost && knownHost.digest === digest) {
                ipc.send(`ssh:${id}:host-key-response`, true)
                return
            }

            const modal = this.ngbModal.open(HostKeyPromptModalComponent)
            modal.componentInstance.selector = selector
            modal.componentInstance.digest = digest
            const accepted = await modal.result.catch(() => false)
            ipc.send(`ssh:${id}:host-key-response`, accepted)
        })
        this.unsubscribers.push(unsubHostKey)

        // Username prompt
        const unsubNeedUsername = ipc.on(`ssh:${id}:need-username`, async (host: string) => {
            const modal = this.ngbModal.open(PromptModalComponent)
            modal.componentInstance.prompt = `Username for ${host}`
            const result = await modal.result.catch(() => null)
            ipc.send(`ssh:${id}:username-response`, result?.value ?? null)
        })
        this.unsubscribers.push(unsubNeedUsername)

        // Password prompt
        const unsubNeedPassword = ipc.on(`ssh:${id}:need-password`, async (username: string, host: string, _hasStoredPassword: boolean, storedPassword: string | null) => {
            const modal = this.ngbModal.open(PromptModalComponent)
            modal.componentInstance.prompt = `Password for ${username}@${host}`
            modal.componentInstance.password = true
            modal.componentInstance.showRememberCheckbox = true
            if (storedPassword) {
                modal.componentInstance.value = storedPassword
            }
            const result = await modal.result.catch(() => null)
            ipc.send(`ssh:${id}:password-response`, result?.value ?? null, result?.remember ?? false)
        })
        this.unsubscribers.push(unsubNeedPassword)

        // Passphrase prompt
        const unsubNeedPassphrase = ipc.on(`ssh:${id}:need-passphrase`, async (_keyHash: string) => {
            const modal = this.ngbModal.open(PromptModalComponent)
            modal.componentInstance.prompt = 'Private key passphrase'
            modal.componentInstance.password = true
            modal.componentInstance.showRememberCheckbox = true
            const result = await modal.result.catch(() => null)
            ipc.send(`ssh:${id}:passphrase-response`, result?.value ?? null, result?.remember ?? false)
        })
        this.unsubscribers.push(unsubNeedPassphrase)

        // Keyboard-interactive
        const unsubKI = ipc.on(`ssh:${id}:keyboard-interactive`, (name: string, instructions: string, prompts: Array<{ prompt: string; echo: boolean }>) => {
            const kiPrompt = new KeyboardInteractivePrompt(name, instructions, prompts)
            this.emitKeyboardInteractivePrompt(kiPrompt)
            kiPrompt.promise.then(responses => {
                ipc.send(`ssh:${id}:ki-response`, responses)
            }).catch(() => {
                ipc.send(`ssh:${id}:ki-response`, [])
            })
        })
        this.unsubscribers.push(unsubKI)

        // Service messages
        const unsubServiceMsg = ipc.on(`ssh:${id}:service-message`, (msg: string) => {
            this.emitServiceMessage(msg)
        })
        this.unsubscribers.push(unsubServiceMsg)

        // Session close
        const unsubClose = ipc.on(`ssh:${id}:close`, () => {
            this.sessionClose$.next()
            this.sessionClose$.complete()
            if (!this.destroyed) {
                this.destroy()
            }
        })
        this.unsubscribers.push(unsubClose)

        await ipc.invoke('ssh:session:connect', this.sessionId, this.serializeProfile())

        this.open = true

        for (const fw of this.profile.options.forwardedPorts) {
            await this.addPortForward(Object.assign(new ForwardedPort(), fw)).catch(e => {
                this.emitServiceMessage(colors.bgRed.black(' X ') + ` Failed to set up port forward ${fw}: ${e}`)
            })
        }
    }

    async openSFTP (): Promise<SFTPSession> {
        const ipc = (window as any).tabbyAPI.ipc
        return new SFTPSession(this.sessionId, ipc, this.injector, this.sessionClose$.asObservable())
    }

    async openShellChannel (options: { x11: boolean }): Promise<ShellChannelProxy> {
        const ipc = (window as any).tabbyAPI.ipc
        await ipc.invoke('ssh:session:open-shell', this.sessionId, options.x11)
        this.shell = new ShellChannelProxy(this.sessionId, ipc)
        return this.shell
    }

    async addPortForward (fw: ForwardedPort): Promise<void> {
        const ipc = (window as any).tabbyAPI.ipc
        try {
            await ipc.invoke('ssh:session:forward-add', this.sessionId, {
                type: fw.type,
                host: fw.host,
                port: fw.port,
                targetAddress: fw.targetAddress,
                targetPort: fw.targetPort,
            })
            if (fw.type === PortForwardType.Local || fw.type === PortForwardType.Dynamic) {
                this.emitServiceMessage(colors.bgGreen.black(' -> ') + ` Forwarded ${fw}`)
            } else {
                this.emitServiceMessage(colors.bgGreen.black(' <- ') + ` Forwarded ${fw}`)
            }
            this.forwardedPorts.push(fw)
        } catch (e) {
            this.emitServiceMessage(colors.bgRed.black(' X ') + ` Failed to forward port ${fw}: ${e}`)
            throw e
        }
    }

    async removePortForward (fw: ForwardedPort): Promise<void> {
        const ipc = (window as any).tabbyAPI.ipc
        try {
            await ipc.invoke('ssh:session:forward-remove', this.sessionId, {
                type: fw.type,
                host: fw.host,
                port: fw.port,
                targetAddress: fw.targetAddress,
                targetPort: fw.targetPort,
            })
        } catch (e) {
            this.logger.warn('Failed to remove port forward:', e)
        }
        fw.stopLocalListener()
        this.forwardedPorts = this.forwardedPorts.filter(x => x !== fw)
        this.emitServiceMessage(`Stopped forwarding ${fw}`)
    }

    async destroy (): Promise<void> {
        if (this.destroyed) {
            return
        }
        this.destroyed = true
        this.logger.info('Destroying')

        this.shell?.close()
        this.shell = null

        for (const unsub of this.unsubscribers) {
            try { unsub() } catch { /* ignore */ }
        }
        this.unsubscribers = []

        this.willDestroy.next()
        this.willDestroy.complete()
        this.serviceMessage.complete()

        try {
            await (window as any).tabbyAPI.ipc.invoke('ssh:session:destroy', this.sessionId)
        } catch (e) {
            this.logger.warn('Error destroying session:', e)
        }

        this.open = false
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
}
