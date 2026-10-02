import stripAnsi from 'strip-ansi'
import { LogService, NotificationsService } from 'tabby-core'
import { Subject, Observable } from 'rxjs'
import { Injector, NgZone } from '@angular/core'
import { BaseSession, InputProcessor, SessionMiddleware, TerminalStreamProcessor, UTF8SplitterMiddleware } from 'tabby-terminal'
import type { ConnectableTerminalProfile, InputProcessingOptions, LoginScriptsOptions, StreamProcessingOptions } from 'tabby-terminal'
import { SerialService } from './services/serial.service'
import type { WebSerialPort } from './services/serial.service'

export interface SerialProfile extends ConnectableTerminalProfile {
    options: SerialProfileOptions
}

export interface SerialProfileOptions extends StreamProcessingOptions, LoginScriptsOptions {
    port: string
    baudrate: number | null
    databits: 5 | 6 | 7 | 8
    stopbits: 1 | 1.5 | 2
    parity: string
    rtscts: boolean
    xon: boolean
    xoff: boolean
    xany: boolean
    slowSend: boolean
    input: InputProcessingOptions,
}

export const BAUD_RATES = [
    110, 150, 300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000,
]

export interface SerialPortInfo {
    name: string
    description?: string
}

class SlowFeedMiddleware extends SessionMiddleware {
    feedFromTerminal (data: Uint8Array): void {
        for (const byte of data) {
            this.outputToSession.next(new Uint8Array([byte]))
        }
    }
}

export class SerialSession extends BaseSession {
    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    private port: WebSerialPort|null = null
    private reader: ReadableStreamDefaultReader<Uint8Array>|null = null
    private writer: WritableStreamDefaultWriter<Uint8Array>|null = null
    private closing: Promise<void>|null = null
    private destroying: Promise<void>|null = null
    private streamProcessor: TerminalStreamProcessor
    private zone: NgZone
    private notifications: NotificationsService
    private serialService: SerialService

    constructor (injector: Injector, public profile: SerialProfile) {
        super(injector.get(LogService).create(`serial-${profile.options.port}`))
        this.serialService = injector.get(SerialService)

        this.zone = injector.get(NgZone)
        this.notifications = injector.get(NotificationsService)

        this.streamProcessor = new TerminalStreamProcessor(profile.options)
        this.middleware.push(this.streamProcessor)

        if (this.profile.options.slowSend) {
            this.middleware.unshift(new SlowFeedMiddleware())
        }

        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))

        this.setLoginScriptsOptions(profile.options)
    }

    async start (): Promise<void> {
        const opened = await this.serialService.open(this.profile.options.port ?? '', this.profile.options)
        this.profile.options.port = opened.name
        this.port = opened.port
        if (!this.port.readable || !this.port.writable) throw new Error('Serial port did not expose readable and writable streams')
        this.reader = this.port.readable.getReader()
        this.writer = this.port.writable.getWriter()

        this.open = true
        setTimeout(() => this.streamProcessor.start())
        void this.readLoop()
        this.loginScriptProcessor?.executeUnconditionalScripts()
    }

    private async readLoop (): Promise<void> {
        try {
            while (this.reader) {
                const { value, done } = await this.reader.read()
                if (done) break
                if (value) this.emitOutput(value)
            }
        } catch (error) {
            if (this.open) this.zone.run(() => this.notifications.error(String(error)))
        } finally {
            if (this.open) {
                this.emitServiceMessage('Port closed')
                void this.destroy()
            }
        }
    }

    write (data: Uint8Array): void {
        void this.writer?.write(data).catch(error => this.zone.run(() => this.notifications.error(String(error))))
    }

    async destroy (): Promise<void> {
        if (!this.destroying) {
            this.destroying = (async () => {
                this.serviceMessage.complete()
                await super.destroy()
            })()
        }
        await this.destroying
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
    resize (_: number, __: number): void {
        this.streamProcessor.resize()
    }

    kill (_?: string): void {
        void this.closePort()
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        await this.closePort()
    }

    supportsWorkingDirectory (): boolean {
        return false
    }

    async getWorkingDirectory (): Promise<string|null> {
        return null
    }

    private async closePort (): Promise<void> {
        if (!this.closing) {
            this.closing = (async () => {
                const reader = this.reader
                this.reader = null
                await reader?.cancel().catch(() => {})
                reader?.releaseLock()
                this.writer?.releaseLock()
                this.writer = null
                await this.port?.close().catch(() => {})
                this.port = null
            })()
        }
        await this.closing
    }
}
