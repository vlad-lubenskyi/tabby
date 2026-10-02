// Derived from: tabby-electron/src/shells/linuxDefault.ts
import { Injectable } from '@angular/core'
import { HostAppService, Platform, LogService, Logger, TranslateService } from 'tabby-core'

import { ShellProvider } from 'tabby-local'
import type { Shell } from 'tabby-local'
import { ipc } from '@gen/ipc'
import { AppConfigService } from '../services/appConfig.service'

/** @hidden */
@Injectable()
export class LinuxDefaultShellProvider extends ShellProvider {
    private logger: Logger

    constructor(
        private hostApp: HostAppService,
        private translate: TranslateService,
        private appConfig: AppConfigService,
        log: LogService,
    ) {
        super()
        this.logger = log.create('linuxDefaultShell')
    }

    async provide(): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Linux) {
            return []
        }

        const logname = this.appConfig.data?.env?.LOGNAME ?? ''
        let passwdContent = ''
        try {
            const result = await ipc.fs.ReadFile({ path: '/etc/passwd' })
            passwdContent = new TextDecoder().decode(result.data)
        } catch {
            // ignore
        }

        const line = passwdContent.split('\n').find(x => x.startsWith(`${logname}:`))
        if (!line) {
            this.logger.warn('Could not detect user shell')
            return [{
                id: 'default',
                name: this.translate.instant('User default'),
                command: '/bin/sh',
                env: {},
                shellType: 'unix',
            }]
        } else {
            return [{
                id: 'default',
                name: this.translate.instant('User default'),
                command: line.split(':')[6],
                args: ['--login'],
                hidden: true,
                env: {},
                shellType: 'unix',
            }]
        }
    }
}
