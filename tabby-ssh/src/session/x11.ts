import { Subject } from 'rxjs'

export class X11Socket {
    error$ = new Subject<Error>()

    static resolveDisplaySpec (_spec?: string | null): { host: string; port: number } {
        return { host: 'localhost', port: 6000 }
    }

    async connect (_spec: string): Promise<never> {
        throw new Error('X11 forwarding is handled by the main process')
    }

    destroy (): void { }
}
