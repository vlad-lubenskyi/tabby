import { Injectable } from '@angular/core'
import { HostAppService } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

@Injectable({ providedIn: 'root' })
export class ShellIntegrationService {
    private constructor (
        private electron: ElectronService,
        private hostApp: HostAppService,
    ) {}

    async isInstalled (): Promise<boolean> {
        return this.electron.ipc.invoke('bridge:shell-integration:is-installed', this.hostApp.platform)
    }

    async install (): Promise<void> {
        await this.electron.ipc.invoke('bridge:shell-integration:install', this.hostApp.platform)
    }

    async remove (): Promise<void> {
        await this.electron.ipc.invoke('bridge:shell-integration:remove', this.hostApp.platform)
    }
}
