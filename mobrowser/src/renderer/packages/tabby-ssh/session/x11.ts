// Derived from: tabby-ssh/src/session/x11.ts
import { Subject } from 'rxjs'

export class X11Socket {
    error$ = new Subject<Error>()

    static resolveDisplaySpec (): { path: string } | { host: string, port: number } {
        return { path: '' }
    }

    connect (_spec: string): Promise<never> {
        return Promise.reject(new Error('X11 forwarding is handled by the main process'))
    }

    destroy (): void {}
}
