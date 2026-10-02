// Derived from: tabby-electron/src/shells/macDefault.ts
import { Injectable } from '@angular/core'
import { HostAppService, Platform, TranslateService } from 'tabby-core'

import { ShellProvider } from 'tabby-local'
import type { Shell } from 'tabby-local'
import { ipc } from '@gen/ipc'

/** @hidden */
@Injectable()
export class MacOSDefaultShellProvider extends ShellProvider {
    private cachedShell?: string

    constructor(
        private hostApp: HostAppService,
        private translate: TranslateService,
    ) {
        super()
    }

    async provide(): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.macOS) {
            return []
        }
        return [{
            id: 'default',
            name: this.translate.instant('OS default'),
            command: await this.getDefaultShellCached(),
            args: ['--login'],
            hidden: true,
            env: {},
            shellType: 'unix',
        }]
    }

    private async getDefaultShellCached() {
        if (!this.cachedShell) {
            this.cachedShell = await this.getDefaultShell()
        }
        return this.cachedShell
    }

    private async getDefaultShell(): Promise<string> {
        try {
            // Try to read from /etc/passwd via IPC
            const result = await ipc.fs.ReadFile({ path: '/etc/passwd' })
            const content = new TextDecoder().decode(result.data)
            const username = (await ipc.platform.PathBasename({ path: '' })).value ?? ''
            const line = content.split('\n').find(x => x.includes(`:${username}:`))
            if (line) {
                return line.split(':')[6] ?? '/bin/zsh'
            }
        } catch {
            // ignore
        }
        return '/bin/zsh'
    }
}
