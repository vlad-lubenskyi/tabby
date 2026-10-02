// Derived from: tabby-electron/src/pty.ts
import { PTYInterface, PTYProxy } from 'tabby-local'
import type { ChildProcess } from 'tabby-local'
import { ipc } from '@gen/ipc'
import { from } from 'rxjs'

export class MoBrowserPTYInterface extends PTYInterface {
    async spawn(command: string, args: string[], opts: any): Promise<PTYProxy> {
        const response = await ipc.pty.Spawn({
            file: command,
            args,
            env: opts.env ?? {},
            cwd: opts.cwd ?? '',
            cols: opts.cols ?? 80,
            rows: opts.rows ?? 24,
        })
        return new MoBrowserPTYProxy(response.ptyId)
    }

    async restore(id: string): Promise<MoBrowserPTYProxy | null> {
        const result = await ipc.pty.Exists({ ptyId: id })
        if (result.value) {
            return new MoBrowserPTYProxy(id)
        }
        return null
    }
}

export class MoBrowserPTYProxy extends PTYProxy {
    private subscriptions: Map<string, () => void> = new Map()
    private truePID: Promise<number>

    constructor(
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

        // Subscribe to data stream
        this._startDataStream()
    }

    private _startDataStream(): void {
        from(ipc.pty.ReadData({ ptyId: this.id })).subscribe({
            next: (chunk) => {
                if (chunk.isExit) {
                    const exitHandler = this._handlers.get('exit')
                    if (exitHandler) {
                        exitHandler(chunk.exitCode)
                    }
                } else {
                    const dataHandler = this._handlers.get('data')
                    if (dataHandler) {
                        dataHandler(chunk.data)
                    }
                }
            },
            error: (err) => {
                const errorHandler = this._handlers.get('error')
                if (errorHandler) {
                    errorHandler(err)
                }
            },
        })
    }

    private _handlers: Map<string, (...args: any[]) => void> = new Map()

    getID(): string {
        return this.id
    }

    getTruePID(): Promise<number> {
        return this.truePID
    }

    async getPID(): Promise<number> {
        const result = await ipc.pty.GetPid({ ptyId: this.id })
        return result.value ?? 0
    }

    subscribe(event: string, handler: (..._: any[]) => void): void {
        this._handlers.set(event, handler)
    }

    ackData(_length: number): void {
        // MoBrowser uses stream backpressure instead of explicit ack
    }

    unsubscribeAll(): void {
        this._handlers.clear()
    }

    async resize(columns: number, rows: number): Promise<void> {
        await ipc.pty.Resize({ ptyId: this.id, cols: columns, rows })
    }

    async write(data: Uint8Array): Promise<void> {
        await ipc.pty.Write({ ptyId: this.id, data })
    }

    async kill(signal?: string): Promise<void> {
        await ipc.pty.Kill({ ptyId: this.id, signal: signal ?? 'SIGTERM' })
    }

    async getChildProcesses(): Promise<ChildProcess[]> {
        return this.getChildProcessesInternal(await this.getTruePID())
    }

    async getChildProcessesInternal(truePID: number): Promise<ChildProcess[]> {
        const result = await ipc.pty.GetChildProcesses({ value: truePID })
        return result.processes.map(p => ({ pid: p.pid, name: p.name }))
    }

    async getWorkingDirectory(): Promise<string | null> {
        const result = await ipc.pty.GetWorkingDirectory({ value: await this.getTruePID() })
        return result.value ?? null
    }
}
