import slugify from 'slugify'
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'

import { ShellProvider, Shell } from 'tabby-local'

/** @hidden */
@Injectable()
export class POSIXShellsProvider extends ShellProvider {
    private get ipc () { return (window as any).tabbyAPI?.ipc }

    constructor (
        private hostApp: HostAppService,
    ) {
        super()
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform === Platform.Windows) {
            return []
        }
        let shellListPath = '/etc/shells'
        if (!await this.ipc.invoke('bridge:fs:exists', shellListPath)) {
            // Solus Linux
            shellListPath = '/usr/share/defaults/etc/shells'
        }
        const raw: Uint8Array = await this.ipc.invoke('bridge:file:read', shellListPath)
        const content = new TextDecoder().decode(raw)
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
