declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform, ConfigService } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

import { Shell } from 'tabby-local'
import { WindowsBaseShellProvider } from './windowsBase'

const ipc = () => (window as any).tabbyAPI?.ipc

/** @hidden */
@Injectable()
export class WindowsStockShellsProvider extends WindowsBaseShellProvider {
    constructor (
        hostApp: HostAppService,
        config: ConfigService,
        private electron: ElectronService,
    ) {
        super(hostApp, config)
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const exeDir: string = await ipc().invoke('bridge:path:dirname', this.electron.exePath)
        const arch: string = (window as any).tabbyAPI.arch

        let clinkPath = exeDir + '\\resources\\extras\\clink\\clink_' + arch + '.exe'

        if ((window as any).tabbyAPI.devMode) {
            clinkPath = exeDir + '\\..\\..\\..\\extras\\clink\\clink_' + arch + '.exe'
        }
        return [
            {
                id: 'clink',
                name: 'CMD (clink)',
                command: 'cmd.exe',
                args: ['/k', clinkPath, 'inject'],
                env: {
                    // Tell clink not to emulate ANSI handling
                    WT_SESSION: '0',
                },
                icon: require('../icons/clink.svg'),
                shellType: 'cmd',
            },
            {
                id: 'cmd',
                name: 'CMD (stock)',
                command: 'cmd.exe',
                env: {},
                icon: require('../icons/cmd.svg'),
                shellType: 'cmd',
            },
            {
                id: 'powershell',
                name: 'PowerShell',
                command: await this.getPowerShellPath(),
                args: ['-nologo'],
                icon: require('../icons/powershell.svg'),
                env: this.getEnvironment(),
                shellType: 'powershell',
            },
        ]
    }

    private async getPowerShellPath (): Promise<string> {
        const env = (window as any).tabbyAPI.env
        // Check well-known paths first to avoid slow PATH scanning
        for (const psPath of [
            (env.USERPROFILE ?? '') + '\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
            (env.ProgramFiles ?? '') + '\\PowerShell\\7\\pwsh.exe',
            (env['ProgramFiles(x86)'] ?? '') + '\\PowerShell\\7\\pwsh.exe',
            (env.SystemRoot ?? '') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            (env.SystemRoot ?? '') + '\\System32\\powershell.exe',
        ]) {
            if (!psPath.startsWith('\\')) {
                try {
                    await ipc().invoke('bridge:fs:stat', psPath)
                    return psPath
                } catch { }
            }
        }
        return 'powershell.exe'
    }
}
