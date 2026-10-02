// Derived from: app/src/entry.ts, tabby-electron/src/services/electron.service.ts
import { Injectable } from '@angular/core'
import { ipc } from '@gen/ipc'
import type { BootstrapData } from '@gen/app'

@Injectable({ providedIn: 'root' })
export class AppConfigService {
    data!: BootstrapData

    async load(): Promise<void> {
        this.data = await ipc.app.GetBootstrapData({})
        ;(window as any).tabbyAPI = {
            platform: this.data.platform,
            arch: this.data.arch,
            osRelease: this.data.osRelease,
            env: this.data.env,
        }
    }
}
