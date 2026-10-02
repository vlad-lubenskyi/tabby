// Derived from: tabby-electron/src/services/updater.service.ts
import { Injectable } from '@angular/core'
import axios from 'axios'

import { Logger, LogService, ConfigService, UpdaterService, PlatformService, TranslateService } from 'tabby-core'
import { ipc } from '@gen/ipc'
import { from } from 'rxjs'
import { AppConfigService } from './appConfig.service'

const UPDATES_URL = 'https://api.github.com/repos/eugeny/tabby/releases/latest'

@Injectable()
export class MoBrowserUpdaterService extends UpdaterService {
    private logger: Logger
    private downloaded: Promise<boolean>
    private updaterAvailable = true
    private updateURL: string

    constructor(
        log: LogService,
        config: ConfigService,
        private translate: TranslateService,
        private platform: PlatformService,
        private appConfig: AppConfigService,
    ) {
        super()
        this.logger = log.create('updater')

        if (this.appConfig.data?.platform === 'linux') {
            this.updaterAvailable = false
            return
        }

        from(ipc.updater.OnUpdateAvailable({})).subscribe(() => {
            this.logger.info('Update available')
        })

        from(ipc.updater.OnUpdateNotAvailable({})).subscribe(() => {
            this.logger.info('No updates')
        })

        from(ipc.updater.OnUpdateError({})).subscribe(err => {
            this.logger.error(err.message)
            this.updaterAvailable = false
        })

        this.downloaded = new Promise<boolean>(resolve => {
            from(ipc.updater.OnUpdateDownloaded({})).subscribe({ next: () => resolve(true) })
        })

        config.ready$.toPromise().then(() => {
            if (config.store.enableAutomaticUpdates && this.updaterAvailable && !this.appConfig.data?.devMode) {
                this.logger.debug('Checking for updates')
                try {
                    ipc.updater.CheckForUpdates({})
                } catch (e) {
                    this.updaterAvailable = false
                    this.logger.info('Updater unavailable, falling back', e)
                }
            }
        })
    }

    async check(): Promise<boolean> {
        if (this.updaterAvailable) {
            return new Promise((resolve, reject) => {
                let settled = false
                const settle = (v: boolean) => {
                    if (!settled) {
                        settled = true
                        resolve(v)
                    }
                }
                from(ipc.updater.OnUpdateNotAvailable({})).subscribe({ next: () => settle(false) })
                from(ipc.updater.OnUpdateAvailable({})).subscribe({ next: () => settle(true) })
                from(ipc.updater.OnUpdateError({})).subscribe({ next: err => { if (!settled) { settled = true; reject(new Error(err.message)) } } })
                ipc.updater.CheckForUpdates({}).catch(e => {
                    this.updaterAvailable = false
                    this.logger.info('Updater unavailable, falling back', e)
                    resolve(this.checkFallback())
                })
            })
        } else {
            return this.checkFallback()
        }
    }

    private async checkFallback(): Promise<boolean> {
        this.logger.debug('Checking for updates through fallback method.')
        const response = await axios.get(UPDATES_URL)
        const data = response.data
        const version = data.tag_name.substring(1)
        if (this.appConfig.data?.appVersion !== version) {
            this.logger.info('Update available')
            this.updateURL = data.html_url
            return true
        }
        this.logger.info('No updates')
        return false
    }

    async update(): Promise<void> {
        if (!this.updaterAvailable) {
            await this.platform.openExternal(this.updateURL)
        } else {
            if ((await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('Installing the update will close all tabs and restart Tabby.'),
                buttons: [
                    this.translate.instant('Update'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 0,
                cancelId: 1,
            })).response === 0) {
                await this.downloaded
                ipc.updater.QuitAndInstall({})
            }
        }
    }
}
