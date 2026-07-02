import { Injectable } from '@angular/core'
import { WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild } from 'tabby-core'
import { SessionOptions, UACService } from 'tabby-local'
import { ElectronService } from './electron.service'

function pathDirname (p: string): string {
    // Works for both Windows and POSIX paths
    const sep = p.includes('\\') ? '\\' : '/'
    const parts = p.split(sep)
    parts.pop()
    return parts.join(sep)
}

/** @hidden */
@Injectable()
export class ElectronUACService extends UACService {
    constructor (
        private electron: ElectronService,
    ) {
        super()
        this.isAvailable = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED)
    }

    patchSessionOptionsForUAC (sessionOptions: SessionOptions): SessionOptions {
        const exeDir = pathDirname(this.electron.exePath)
        let helperPath = exeDir + '\\resources\\extras\\UAC.exe'

        if (this.electron.devMode) {
            helperPath = exeDir + '\\..\\..\\..\\extras\\UAC.exe'
        }

        const options = { ...sessionOptions }
        options.args = [options.command, ...options.args]
        options.command = helperPath
        return options
    }
}
