import { SessionMiddleware } from '../api/middleware'

export interface InputProcessingOptions {
    backspace: 'ctrl-h'|'ctrl-?'|'delete'|'backspace'
}

export class InputProcessor extends SessionMiddleware {
    constructor (
        private options: InputProcessingOptions,
    ) {
        super()
    }

    feedFromTerminal (data: Uint8Array): void {
        if (data.length === 1 && data[0] === 0x7f) {
            if (this.options.backspace === 'ctrl-h') {
                data = new Uint8Array([0x08])
            } else if (this.options.backspace === 'ctrl-?') {
                data = new Uint8Array([0x7f])
            } else if (this.options.backspace === 'delete') {
                data = new TextEncoder().encode('\x1b[3~')
            } else {
                data = new Uint8Array([0x7f])
            }
        }
        this.outputToSession.next(data)
    }
}
