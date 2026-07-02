import { ChildProcess, PTYInterface, PTYProxy } from 'tabby-local'

const ipc = () => (window as any).tabbyAPI?.ipc

export class ElectronPTYInterface extends PTYInterface {
    async spawn (...options: any[]): Promise<PTYProxy> {
        const id = await ipc().invoke('pty:spawn', ...options)
        return new ElectronPTYProxy(id)
    }

    async restore (id: string): Promise<ElectronPTYProxy|null> {
        if (await ipc().invoke('pty:exists', id)) {
            return new ElectronPTYProxy(id)
        }
        return null
    }
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ElectronPTYProxy extends PTYProxy {
    private subscriptions: Map<string, () => void> = new Map()
    private truePID: Promise<number>

    constructor (
        private id: string,
    ) {
        super()
        this.truePID = new Promise(async (resolve) => {
            let pid = await this.getPID()
            try {
                await new Promise(r => setTimeout(r, 2000))

                // Retrieve any possible single children now that shell has fully started
                let processes = await this.getChildProcessesInternal(pid)
                while (pid && processes.length === 1) {
                    if (!processes[0].pid) {
                        break
                    }
                    pid = processes[0].pid
                    processes = await this.getChildProcessesInternal(pid)
                }
            } finally {
                resolve(pid)
            }
        })
        this.truePID = this.truePID.catch(() => this.getPID())
    }

    getID (): string {
        return this.id
    }

    getTruePID (): Promise<number> {
        return this.truePID
    }

    async getPID (): Promise<number> {
        return ipc().invoke('pty:get-pid', this.id)
    }

    subscribe (event: string, handler: (..._: any[]) => void): void {
        const key = `pty:${this.id}:${event}`
        // ipc.on strips the Electron _event argument and returns an unsubscribe function
        const unsubscribe = ipc().on(key, handler)
        this.subscriptions.set(key, unsubscribe)
    }

    ackData (length: number): void {
        ipc().send('pty:ack-data', this.id, length)
    }

    unsubscribeAll (): void {
        for (const unsubscribe of this.subscriptions.values()) {
            unsubscribe()
        }
        this.subscriptions.clear()
    }

    async resize (columns: number, rows: number): Promise<void> {
        ipc().send('pty:resize', this.id, columns, rows)
    }

    async write (data: Uint8Array): Promise<void> {
        ipc().send('pty:write', this.id, data)
    }

    async kill (signal?: string): Promise<void> {
        ipc().send('pty:kill', this.id, signal)
    }

    async getChildProcesses (): Promise<ChildProcess[]> {
        return this.getChildProcessesInternal(await this.getTruePID())
    }

    async getChildProcessesInternal (truePID: number): Promise<ChildProcess[]> {
        return ipc().invoke('pty:get-child-processes', truePID)
    }

    async getWorkingDirectory (): Promise<string|null> {
        return ipc().invoke('pty:get-working-directory', await this.getTruePID())
    }

}
