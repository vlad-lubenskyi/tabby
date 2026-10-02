// Derived from: tabby-electron/src/shells/posix.ts
import slugify from 'slugify'
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider } from 'tabby-local'
import type { Shell } from 'tabby-local'
import { ipc } from '@gen/ipc'

/** @hidden */
@Injectable()
export class POSIXShellsProvider extends ShellProvider {
    constructor(
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide(): Promise<Shell[]> {
        if (this.hostApp.platform === Platform.Windows) {
            return []
        }

        let shellListPath = '/etc/shells'
        const existsResult = await ipc.fs.Exists({ path: shellListPath })
        if (!existsResult.value) {
            // Solus Linux
            shellListPath = '/usr/share/defaults/etc/shells'
        }

        let content = ''
        try {
            const result = await ipc.fs.ReadFile({ path: shellListPath })
            content = new TextDecoder().decode(result.data)
        } catch {
            return []
        }

        return content
            .split('\n')
            .map(x => x.trim())
            .filter(x => x && !x.startsWith('#'))
            .map(x => ({
                id: slugify(x),
                name: x.split('/').pop() ?? x,
                icon: 'fas fa-terminal',
                command: x,
                args: ['-l'],
                env: {},
                shellType: 'unix',
            }))
    }
}
