import hexdump from 'hexer'
import bufferReplace from 'buffer-replace'
import colors from 'ansi-colors'
import binstring from 'binstring'
import { interval, debounce } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

class SimplePassThrough {
    private _listeners = new Map<string, Array<(...a: any[]) => void>>()

    on (event: string, listener: (...args: any[]) => void): this {
        if (!this._listeners.has(event)) this._listeners.set(event, [])
        this._listeners.get(event)!.push(listener)
        return this
    }

    write (data: any): boolean {
        for (const fn of this._listeners.get('data') ?? []) fn(data)
        return true
    }

    emit (event: string, ...args: any[]): boolean {
        const fns = this._listeners.get(event) ?? []
        for (const fn of fns) fn(...args)
        return fns.length > 0
    }
}

class SimpleReadline {
    private _buf = ''
    private _listeners = new Map<string, Array<(...a: any[]) => void>>()
    private _enc = new TextEncoder()

    constructor (private _opts: { input: SimplePassThrough; output: SimplePassThrough; terminal?: boolean; prompt?: string }) {
        _opts.input.on('data', (data: Uint8Array | string) => {
            const s = typeof data === 'string' ? data : new TextDecoder().decode(data)
            for (const ch of s) {
                if (ch === '\r' || ch === '\n') {
                    const line = this._buf
                    this._buf = ''
                    for (const fn of this._listeners.get('line') ?? []) fn(line)
                } else if (ch === '\x7f' || ch === '\x08') {
                    if (this._buf.length) {
                        this._buf = this._buf.slice(0, -1)
                        _opts.output.write(this._enc.encode('\x08 \x08'))
                    }
                } else {
                    this._buf += ch
                    _opts.output.write(this._enc.encode(ch))
                }
            }
        })
    }

    on (event: string, listener: (...args: any[]) => void): this {
        if (!this._listeners.has(event)) this._listeners.set(event, [])
        this._listeners.get(event)!.push(listener)
        return this
    }

    prompt (_preserveCursor?: boolean): void {
        this._opts.output.write(this._enc.encode(this._opts.prompt ?? '> '))
    }

    close (): void { /* nothing to clean up */ }
}

function clearLine (stream: SimplePassThrough, _dir: number): void {
    stream.write(new TextEncoder().encode('\x1b[2K\r'))
}

export type InputMode = null | 'local-echo' | 'readline' | 'readline-hex'
export type OutputMode = null | 'hex'
export type NewlineMode = null | 'cr' | 'lf' | 'crlf' | 'implicit_cr' | 'implicit_lf'

export interface StreamProcessingOptions {
    inputMode: InputMode
    inputNewlines: NewlineMode
    outputMode: OutputMode
    outputNewlines: NewlineMode
}

const _enc = new TextEncoder()

function concatUint8 (...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((n, a) => n + a.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const a of arrays) { result.set(a, offset); offset += a.length }
    return result
}

export class TerminalStreamProcessor extends SessionMiddleware {
    forceEcho = false
    private inputReadline: SimpleReadline|null = null
    private inputPromptVisible = false
    private inputReadlineInStream: SimplePassThrough
    private inputReadlineOutStream: SimplePassThrough
    private started = false

    constructor (private options: StreamProcessingOptions) {
        super()
        this.inputReadlineInStream = new SimplePassThrough()
        this.inputReadlineOutStream = new SimplePassThrough()
        this.inputReadlineOutStream.on('data', (data: Uint8Array | ArrayBuffer) => {
            this.outputToTerminal.next(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
        })
        this.outputToTerminal$.pipe(debounce(() => interval(500))).subscribe(() => {
            if (this.started) {
                this.onOutputSettled()
            }
        })
    }

    start (): void {
        this.inputReadline = new SimpleReadline({
            input: this.inputReadlineInStream,
            output: this.inputReadlineOutStream,
            terminal: true,
            prompt: this.options.inputMode === 'readline-hex' ? 'hex> ' : '> ',
        })
        this.inputReadline.on('line', line => {
            this.onTerminalInput(_enc.encode(line + '\n'))
            this.resetInputPrompt()
        })
        this.started = true
    }

    feedFromSession (data: Uint8Array): void {
        if (this.options.inputMode?.startsWith('readline')) {
            if (this.inputPromptVisible) {
                clearLine(this.inputReadlineOutStream, 0)
                this.outputToTerminal.next(_enc.encode('\r'))
                this.inputPromptVisible = false
            }
        }

        data = this.replaceNewlines(data, this.options.outputNewlines)

        if (this.options.outputMode === 'hex') {
            this.outputToTerminal.next(concatUint8(
                _enc.encode('\r\n'),
                _enc.encode(hexdump(data, {
                    group: 1,
                    gutter: 4,
                    divide: colors.gray(' ｜ '),
                    emptyHuman: colors.gray('╳'),
                }).replaceAll('\n', '\r\n')),
                _enc.encode('\r\n\n'),
            ))
        } else {
            this.outputToTerminal.next(data)
        }
    }

    feedFromTerminal (data: Uint8Array): void {
        if (this.options.inputMode === 'local-echo' || this.forceEcho) {
            this.outputToTerminal.next(this.replaceNewlines(data, 'crlf'))
        }
        if (this.options.inputMode?.startsWith('readline')) {
            this.inputReadlineInStream.write(data)
        } else {
            this.onTerminalInput(data)
        }
    }

    resize (): void {
        if (this.options.inputMode?.startsWith('readline')) {
            this.inputReadlineOutStream.emit('resize')
        }
    }

    close (): void {
        this.inputReadline?.close()
        super.close()
    }

    private onTerminalInput (data: Uint8Array) {
        if (this.options.inputMode === 'readline-hex') {
            const tokens = new TextDecoder().decode(data).split(/\s/g)
            const parts: Uint8Array[] = tokens.filter(t => !!t).map(t => {
                if (t.startsWith('0x')) {
                    t = t.substring(2)
                }
                return binstring(t, { 'in': 'hex' }) as Uint8Array
            })
            data = concatUint8(...parts)
        }

        data = this.replaceNewlines(data, this.options.inputNewlines)
        this.outputToSession.next(data)
    }

    private onOutputSettled () {
        if (this.options.inputMode?.startsWith('readline') && !this.inputPromptVisible) {
            this.resetInputPrompt()
        }
    }

    private resetInputPrompt () {
        this.outputToTerminal.next(_enc.encode('\r\n'))
        this.inputReadline?.prompt(true)
        this.inputPromptVisible = true
    }

    private replaceNewlines (data: Uint8Array, mode?: NewlineMode): Uint8Array {
        if (!mode) {
            return data
        } else if (mode === 'implicit_cr') {
            return bufferReplace(data, '\n', '\r\n') as Uint8Array
        } else if (mode === 'implicit_lf') {
            return bufferReplace(data, '\r', '\r\n') as Uint8Array
        }

        data = bufferReplace(data, '\r\n', '\n') as Uint8Array
        data = bufferReplace(data, '\r', '\n') as Uint8Array
        const replacement = {
            strip: '',
            cr: '\r',
            lf: '\n',
            crlf: '\r\n',
        }[mode]
        return bufferReplace(data, '\n', replacement) as Uint8Array
    }
}
