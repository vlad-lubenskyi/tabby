declare const require: (module: string) => any
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider, Shell } from 'tabby-local'

const ipc = () => (window as any).tabbyAPI?.ipc

/** @hidden */
@Injectable()
export class MSYS2ShellProvider extends ShellProvider {
    constructor (
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        const systemRoot: string = (window as any).tabbyAPI.env.SystemRoot ?? 'C:\\Windows'
        // resolve C:\Windows\..\msys64 => normalize the path via IPC
        const msys2Path: string = await ipc().invoke('bridge:path:join', systemRoot, '..\\msys64')
        const msys2PathNorm: string = await ipc().invoke('bridge:path:join', msys2Path)
        try {
            await ipc().invoke('bridge:fs:stat', msys2PathNorm)
        } catch {
            return []
        }

        const username: string = (window as any).tabbyAPI.env.USERNAME ?? ''
        let homePath: string | undefined = msys2PathNorm + '\\home\\' + username
        try {
            await ipc().invoke('bridge:fs:stat', homePath)
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
