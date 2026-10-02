// Copied from: tabby-electron/src/shells/cygwin32.ts
declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider } from 'tabby-local'
import type { Shell } from 'tabby-local'

/* eslint-disable block-scoped-var */

try {
    var wnr = require('windows-native-registry') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch { }

/** @hidden */
@Injectable()
export class Cygwin32ShellProvider extends ShellProvider {
    constructor(
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide(): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const cygwinPath = wnr.getRegistryValue(wnr.HK.LM, 'Software\\WOW6432Node\\Cygwin\\setup', 'rootdir')

        if (!cygwinPath) {
            return []
        }

        return [{
            id: 'cygwin32',
            name: 'Cygwin (32 bit)',
            command: cygwinPath + '\\bin\\bash.exe',
            args: ['--login', '-i'],
            icon: require('../icons/cygwin.svg'),
            env: {
                TERM: 'cygwin',
            },
            shellType: 'unix',
        }]
    }
}
