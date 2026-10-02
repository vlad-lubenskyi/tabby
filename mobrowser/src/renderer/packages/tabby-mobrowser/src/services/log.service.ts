// Derived from: tabby-electron/src/services/log.service.ts
import { Injectable } from '@angular/core'
import { ConsoleLogger, Logger } from 'tabby-core'
import { ipc } from '@gen/ipc'

class IpcLogger extends ConsoleLogger {
    constructor(name: string) {
        super(name)
    }

    protected doLog(level: string, ...args: any[]): void {
        super.doLog(level, ...args)
        const serializable = args.map(a => {
            if (a === null || a === undefined) { return a }
            if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') { return a }
            if (a instanceof Error) { return `${a.name}: ${a.message}` }
            try { return JSON.parse(JSON.stringify(a)) } catch { return String(a) }
        })
        const message = `[${this.name}] ${serializable.map(s => String(s)).join(' ')}`
        ipc.log.Log({ level, message })
    }
}

@Injectable({ providedIn: 'root' })
export class MoBrowserLogService {
    create(name: string): Logger {
        return new IpcLogger(name)
    }
}
