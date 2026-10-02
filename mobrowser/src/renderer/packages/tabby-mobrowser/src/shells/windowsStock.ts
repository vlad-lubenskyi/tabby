// Derived from: tabby-electron/src/shells/windowsStock.ts
declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform, ConfigService } from 'tabby-core'
import { AppConfigService } from '../services/appConfig.service'

import type { Shell } from 'tabby-local'
import { WindowsBaseShellProvider } from './windowsBase'
import { ipc } from '@gen/ipc'

/** @hidden */
@Injectable()
export class WindowsStockShellsProvider extends WindowsBaseShellProvider {
    constructor(
        hostApp: HostAppService,
        config: ConfigService,
        private appConfig: AppConfigService,
    ) {
        super(hostApp, config)
    }

    async provide(): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const exePathResult = await ipc.platform.PathDirname({ path: this.appConfig.data?.exePath ?? '' })
        const exeDir: string = exePathResult.value ?? ''
        const arch: string = this.appConfig.data?.arch ?? 'x64'

        let clinkPath = exeDir + '\\resources\\extras\\clink\\clink_' + arch + '.exe'

        if (this.appConfig.data?.devMode) {
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

    private async getPowerShellPath(): Promise<string> {
        const env = this.appConfig.data?.env ?? {}
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
                    await ipc.fs.Stat({ path: psPath })
                    return psPath
                } catch { }
            }
        }
        return 'powershell.exe'
    }
}
