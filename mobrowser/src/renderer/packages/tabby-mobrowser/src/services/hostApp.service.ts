// Derived from: tabby-electron/src/services/hostApp.service.ts
import { Injectable, NgZone, Injector } from '@angular/core'
import { HostAppService, Platform, CLIHandler } from 'tabby-core'
import { from } from 'rxjs'
import { ipc } from '@gen/ipc'
import { AppConfigService } from './appConfig.service'

@Injectable({ providedIn: 'root' })
export class MoBrowserHostAppService extends HostAppService {
    get platform(): Platform {
        const p = this.appConfig.data?.platform ?? 'linux'
        return ({
            win32: Platform.Windows,
            darwin: Platform.macOS,
            linux: Platform.Linux,
        }[p] ?? Platform.Linux) as Platform
    }

    get configPlatform(): Platform {
        return this.platform
    }

    constructor(
        private appConfig: AppConfigService,
        private zone: NgZone,
        injector: Injector,
    ) {
        super(injector)

        from(ipc.app.OnPreferencesRequested({})).subscribe(() =>
            this.zone.run(() => this.settingsUIRequest.next()))

        from(ipc.app.OnCliInvocation({})).subscribe(({ args }) =>
            this.zone.run(async () => {
                const handlers = injector.get(CLIHandler) as unknown as CLIHandler[]
                handlers.sort((a, b) => b.priority - a.priority)
                let handled = false
                for (const h of handlers) {
                    if (handled && h.firstMatchOnly) { continue }
                    if (await h.handle({ argv: args, cwd: '', secondInstance: false })) {
                        handled = true
                    }
                }
            }))

        from(ipc.app.OnConfigChange({})).subscribe(() =>
            this.zone.run(() => this.configChangeBroadcast.next()))
    }

    newWindow(): void { ipc.app.NewWindow({}) }

    async saveConfig(data: string): Promise<void> {
        await ipc.app.SaveConfig({ data: new TextEncoder().encode(data) })
    }

    async relaunch(): Promise<void> { await ipc.app.Relaunch({}) }

    async quit(): Promise<void> { await ipc.app.Quit({}) }

    emitReady(): void { /* no-op — MoBrowser has no app:ready gate */ }
}
