// Derived from: tabby-electron/src/shells/msys2.ts
declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider } from 'tabby-local'
import type { Shell } from 'tabby-local'
import { ipc } from '@gen/ipc'
import { AppConfigService } from '../services/appConfig.service'

/** @hidden */
@Injectable()
export class MSYS2ShellProvider extends ShellProvider {
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
        const systemRoot: string = env.SystemRoot ?? 'C:\\Windows'

        // resolve path via IPC
        const joinedResult = await ipc.platform.PathJoin({ parts: [systemRoot, '..', 'msys64'] })
        const msys2PathNorm: string = joinedResult.value ?? ''

        try {
            await ipc.fs.Stat({ path: msys2PathNorm })
        } catch {
            return []
        }

        const username: string = env.USERNAME ?? ''
        let homePath: string | undefined = msys2PathNorm + '\\home\\' + username
        try {
            await ipc.fs.Stat({ path: homePath })
        } catch {
            homePath = undefined
        }

        const environments = ['msys', 'mingw64', 'clang64', 'ucrt64']

        return environments.map(e => ({
            id: `msys2-${e}`,
            name: `MSYS2 (${e.toUpperCase()})`,
            command: msys2PathNorm + '\\msys2_shell.cmd',
            args: ['-defterm', '-here', '-no-start', '-' + e],
            icon: require('../icons/msys2.svg'),
            env: {},
            cwd: homePath,
            shellType: 'unix',
        }))
    }
}
