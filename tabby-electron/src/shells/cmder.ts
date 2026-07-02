declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider, Shell } from 'tabby-local'

/** @hidden */
@Injectable()
export class CmderShellProvider extends ShellProvider {
    constructor (
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const cmderRoot = (window as any).tabbyAPI.env.CMDER_ROOT
        if (!cmderRoot) {
            return []
        }

        return [
            {
                id: 'cmder',
                name: 'Cmder',
                command: 'cmd.exe',
                args: [
                    '/k',
                    cmderRoot + '\\vendor\\init.bat',
                ],
                icon: require('../icons/cmder.svg'),
                env: {
                    TERM: 'cygwin',
                },
                shellType: 'cmd',
            },
            {
                id: 'cmderps',
                name: 'Cmder PowerShell',
                command: 'powershell.exe',
                args: [
                    '-ExecutionPolicy',
                    'Bypass',
                    '-nologo',
                    '-noprofile',
                    '-noexit',
                    '-command',
                    `Invoke-Expression '. ''${cmderRoot}\\vendor\\profile.ps1'''`,
                ],
                icon: require('../icons/cmder-powershell.svg'),
                env: {},
                shellType: 'powershell',
            },
        ]
    }
}
