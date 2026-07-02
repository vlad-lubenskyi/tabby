import { Injectable } from '@angular/core'
import { ConsoleLogger, Logger } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

class IpcLogger extends ConsoleLogger {
    constructor (private electron: ElectronService, name: string) {
        super(name)
    }

    protected doLog (level: string, ...args: any[]): void {
        super.doLog(level, ...args)
        const serializable = args.map(a => {
            if (a === null || a === undefined) { return a }
            if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') { return a }
            if (a instanceof Error) { return `${a.name}: ${a.message}` }
            try { return JSON.parse(JSON.stringify(a)) } catch { return String(a) }
        })
        this.electron.ipc.send('bridge:log', level, this.name, serializable)
    }
}

@Injectable({ providedIn: 'root' })
export class ElectronLogService {
    constructor (private electron: ElectronService) {}

    create (name: string): Logger {
        return new IpcLogger(this.electron, name)
    }
}
