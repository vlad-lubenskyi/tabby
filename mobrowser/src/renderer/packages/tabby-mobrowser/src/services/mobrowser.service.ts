// Derived from: tabby-electron/src/services/electron.service.ts
import { Injectable } from '@angular/core'
import { ipc } from '@gen/ipc'
import { AppConfigService } from './appConfig.service'
import type { BootstrapData } from '@gen/app'

@Injectable({ providedIn: 'root' })
export class MoBrowserService {
    readonly ipc = ipc

    constructor(private appConfig: AppConfigService) {}

    get bootstrapData(): BootstrapData { return this.appConfig.data }
    get appVersion(): string { return this.appConfig.data.appVersion }
    get userDataPath(): string { return this.appConfig.data.userDataPath }
    get exePath(): string { return this.appConfig.data.exePath }
    get appPath(): string { return this.appConfig.data.appPath }
    get arch(): string { return this.appConfig.data.arch }
    get platform(): string { return this.appConfig.data.platform }
    get devMode(): boolean { return this.appConfig.data.devMode }
    get env(): Record<string, string> { return this.appConfig.data.env }
}
