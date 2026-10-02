// Derived from: tabby-electron/src/shells/vs.ts
declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider } from 'tabby-local'
import type { Shell } from 'tabby-local'
import { ipc } from '@gen/ipc'
import { AppConfigService } from '../services/appConfig.service'

/* eslint-disable quote-props */
const vsIconMap: Record<string, string> = {
    '2017': require('../icons/vs2017.svg'),
    '2019': require('../icons/vs2019.svg'),
    '2022': require('../icons/vs2022.svg'),
}
/* eslint-enable quote-props */

/** @hidden */
@Injectable()
export class VSDevToolsProvider extends ShellProvider {
    constructor(
        private hostApp: HostAppService,
        private appConfig: AppConfigService,
    ) {
        super()
    }

    async provide(): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const env = this.appConfig.data?.env ?? {}
        const programFilesX86: string = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
        const programFiles: string = env.ProgramFiles ?? 'C:\\Program Files'
        const x86ParentPath = programFilesX86 + '\\Microsoft Visual Studio'
        const x64ParentPath = programFiles + '\\Microsoft Visual Studio'

        const result: Shell[] = []
        for (const parentPath of [x86ParentPath, x64ParentPath]) {
            try {
                await ipc.fs.Stat({ path: parentPath })
                const readResult = await ipc.fs.ReadDir({ path: parentPath })
                for (const name of readResult.entries) {
                    const version = name
                    const bat = parentPath + '\\' + version + '\\Community\\Common7\\Tools\\VsDevCmd.bat'
                    try {
                        await ipc.fs.Stat({ path: bat })
                    } catch {
                        continue
                    }
                    result.push({
                        id: `vs-cmd-${version}`,
                        name: `Developer Prompt for VS ${version}`,
                        command: 'cmd.exe',
                        args: ['/k', bat],
                        icon: vsIconMap[version],
                        env: {},
                        shellType: 'cmd',
                    })
                }
            } catch (_) {
                // Ignore
            }
        }
        return result
    }
}
