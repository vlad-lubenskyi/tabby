declare const require: (module: string) => any
import hexdump from 'hexer'
import bufferReplace from 'buffer-replace'
import colors from 'ansi-colors'
import binstring from 'binstring'
import { interval, debounce } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

// Minimal local interfaces for Node.js stream/readline types used at runtime.
// The actual implementations are provided at runtime via Node.js require (available
// in the Electron main process context), but TypeScript only needs the shapes.
interface NodeStream {
    on(event: string, listener: (...args: any[]) => void): this
    write(data: any): boolean
    emit(event: string, ...args: any[]): boolean
}

interface ReadLine {
    on(event: string, listener: (...args: any[]) => void): this
    prompt(preserveCursor?: boolean): void
    close(): void
}

const { PassThrough } = require('stream') as { PassThrough: new () => NodeStream }
const { createInterface: createReadline, clearLine } = require('readline') as {
    createInterface: (options: any) => ReadLine
    clearLine: (stream: NodeStream, dir: number) => void
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
    private inputReadline: ReadLine|null = null
    private inputPromptVisible = false
    private inputReadlineInStream: NodeStream
    private inputReadlineOutStream: NodeStream
    private started = false

    constructor (private options: StreamProcessingOptions) {
        super()
        this.inputReadlineInStream = new PassThrough()
        this.inputReadlineOutStream = new PassThrough()
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
        this.inputReadline = createReadline({
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
