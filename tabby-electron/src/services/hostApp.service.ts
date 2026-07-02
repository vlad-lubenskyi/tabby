import { Injectable, NgZone, Injector } from '@angular/core'
import { isWindowsBuild, WIN_BUILD_FLUENT_BG_SUPPORTED, HostAppService, Platform, CLIHandler } from 'tabby-core'
import { ElectronService } from '../services/electron.service'


@Injectable({ providedIn: 'root' })
export class ElectronHostAppService extends HostAppService {
    get platform (): Platform {
        return this.configPlatform
    }

    get configPlatform (): Platform {
        const p = (window as any).tabbyAPI?.platform ?? 'linux'
        return {
            win32: Platform.Windows,
            darwin: Platform.macOS,
            linux: Platform.Linux,
        }[p] ?? Platform.Linux
    }

    constructor (
        private zone: NgZone,
        private electron: ElectronService,
        injector: Injector,
    ) {
        super(injector)

        electron.ipc.on('host:preferences-menu', () => this.zone.run(() => this.settingsUIRequest.next()))

        electron.ipc.on('cli', (argv: any, cwd: string, secondInstance: boolean) => this.zone.run(async () => {
            const event = { argv, cwd, secondInstance }
            this.logger.info('CLI arguments received:', event)

            const cliHandlers = injector.get(CLIHandler) as unknown as CLIHandler[]
            cliHandlers.sort((a, b) => b.priority - a.priority)

            let handled = false
            for (const handler of cliHandlers) {
                if (handled && handler.firstMatchOnly) {
                    continue
                }
                if (await handler.handle(event)) {
                    this.logger.info('CLI handler matched:', handler.constructor.name)
                    handled = true
                }
            }
        }))

        electron.ipc.on('host:config-change', () => this.zone.run(() => {
            this.configChangeBroadcast.next()
        }))

        if (isWindowsBuild(WIN_BUILD_FLUENT_BG_SUPPORTED)) {
            electron.ipc.send('window-set-disable-vibrancy-while-dragging', true)
        }
    }

    newWindow (): void {
        this.electron.ipc.send('app:new-window')
    }

    async saveConfig (data: string): Promise<void> {
        await this.electron.ipc.invoke('app:save-config', data)
    }

    emitReady (): void {
        this.electron.ipc.send('app:ready')
    }

    async relaunch (): Promise<void> {
        const isPortable = !!this.electron.portableExecutableFile
        if (isPortable) {
            await this.electron.relaunch({ execPath: this.electron.portableExecutableFile ?? undefined })
        } else {
            let args: string[] = []
            if (this.platform === Platform.Linux) {
                args = ['--no-sandbox']
            }
            await this.electron.relaunch({ args })
        }
        await this.electron.exit()
    }

    async quit (): Promise<void> {
        this.logger.info('Quitting')
        await this.electron.quit()
    }
}
