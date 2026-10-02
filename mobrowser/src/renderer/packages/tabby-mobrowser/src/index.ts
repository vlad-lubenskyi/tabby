// Derived from: tabby-electron/src/index.ts
import { NgModule, APP_INITIALIZER } from '@angular/core'
import {
    PlatformService,
    LogService,
    UpdaterService,
    HostAppService,
    ThemesService,
    Platform,
    AppService,
    ConfigService,
    HostWindowService,
    HotkeyProvider,
    ConfigProvider,
    FileProvider,
} from 'tabby-core'
import { TerminalColorSchemeProvider, TerminalContextMenuItemProvider, TerminalDecorator } from 'tabby-terminal'
import { PTYInterface, ShellProvider } from 'tabby-local'
import { auditTime } from 'rxjs'

import { HyperColorSchemes } from './colorSchemes'
import { MoBrowserPlatformService } from './services/platform.service'
import { MoBrowserLogService } from './services/log.service'
import { MoBrowserUpdaterService } from './services/updater.service'
import { MoBrowserHostWindow } from './services/hostWindow.service'
import { MoBrowserFileProvider } from './services/fileProvider.service'
import { MoBrowserHostAppService } from './services/hostApp.service'
import { AppConfigService } from './services/appConfig.service'

import { MoBrowserHotkeyProvider } from './hotkeys'
import { MoBrowserConfigProvider } from './config'
import { ExportTerminalContextMenu } from './terminalContextMenu'
import { MoBrowserPTYInterface } from './pty'
import { PathDropDecorator } from './pathDrop'

import { CmderShellProvider } from './shells/cmder'
import { Cygwin32ShellProvider } from './shells/cygwin32'
import { Cygwin64ShellProvider } from './shells/cygwin64'
import { GitBashShellProvider } from './shells/gitBash'
import { LinuxDefaultShellProvider } from './shells/linuxDefault'
import { MacOSDefaultShellProvider } from './shells/macDefault'
import { MSYS2ShellProvider } from './shells/msys2'
import { POSIXShellsProvider } from './shells/posix'
import { PowerShellCoreShellProvider } from './shells/powershellCore'
import { WindowsDefaultShellProvider } from './shells/winDefault'
import { WindowsStockShellsProvider } from './shells/windowsStock'
import { WSLShellProvider } from './shells/wsl'
import { VSDevToolsProvider } from './shells/vs'

import { ipc } from '@gen/ipc'

export function appConfigInitializer(appConfig: AppConfigService): () => Promise<void> {
    return () => appConfig.load()
}

@NgModule({
    providers: [
        {
            provide: APP_INITIALIZER,
            useFactory: appConfigInitializer,
            deps: [AppConfigService],
            multi: true,
        },

        { provide: TerminalColorSchemeProvider, useClass: HyperColorSchemes, multi: true },
        { provide: PlatformService, useExisting: MoBrowserPlatformService },
        { provide: HostWindowService, useExisting: MoBrowserHostWindow },
        { provide: HostAppService, useExisting: MoBrowserHostAppService },
        { provide: LogService, useClass: MoBrowserLogService },
        { provide: UpdaterService, useClass: MoBrowserUpdaterService },
        { provide: HotkeyProvider, useClass: MoBrowserHotkeyProvider, multi: true },
        { provide: ConfigProvider, useClass: MoBrowserConfigProvider, multi: true },
        { provide: FileProvider, useClass: MoBrowserFileProvider, multi: true },

        { provide: ShellProvider, useClass: WindowsDefaultShellProvider, multi: true },
        { provide: ShellProvider, useClass: MacOSDefaultShellProvider, multi: true },
        { provide: ShellProvider, useClass: LinuxDefaultShellProvider, multi: true },
        { provide: ShellProvider, useClass: WindowsStockShellsProvider, multi: true },
        { provide: ShellProvider, useClass: PowerShellCoreShellProvider, multi: true },
        { provide: ShellProvider, useClass: CmderShellProvider, multi: true },
        { provide: ShellProvider, useClass: Cygwin32ShellProvider, multi: true },
        { provide: ShellProvider, useClass: Cygwin64ShellProvider, multi: true },
        { provide: ShellProvider, useClass: GitBashShellProvider, multi: true },
        { provide: ShellProvider, useClass: POSIXShellsProvider, multi: true },
        { provide: ShellProvider, useClass: MSYS2ShellProvider, multi: true },
        { provide: ShellProvider, useClass: WSLShellProvider, multi: true },
        { provide: ShellProvider, useClass: VSDevToolsProvider, multi: true },

        { provide: PTYInterface, useClass: MoBrowserPTYInterface },

        { provide: TerminalDecorator, useClass: PathDropDecorator, multi: true },

        { provide: TerminalContextMenuItemProvider, useClass: ExportTerminalContextMenu, multi: true },

        // For WindowsDefaultShellProvider
        PowerShellCoreShellProvider,
        WSLShellProvider,
        WindowsStockShellsProvider,
    ],
})
export default class MoBrowserModule {
    constructor(
        private config: ConfigService,
        private hostApp: MoBrowserHostAppService,
        private hostWindow: MoBrowserHostWindow,
        themeService: ThemesService,
        app: AppService,
    ) {
        config.ready$.toPromise().then(() => {
            hostWindow.windowShown$.subscribe(() => {
                // docking equivalent could be wired here
            })
            this.registerGlobalHotkey()
        })

        config.changed$.subscribe(() => {
            this.registerGlobalHotkey()
            this.updateVibrancy()
        })

        themeService.themeChanged$.subscribe(theme => {
            if (hostApp.platform === Platform.macOS) {
                hostWindow.setTrafficLightPosition(
                    (theme as any).macOSWindowButtonsInsetX ?? 14,
                    (theme as any).macOSWindowButtonsInsetY ?? 11,
                )
            }
        })

        let lastProgress: number | null = null
        app.tabOpened$.subscribe(tab => {
            tab.progress$.pipe(auditTime(250)).subscribe(progress => {
                if (lastProgress === progress) {
                    return
                }
                if (progress !== null) {
                    hostWindow.setProgressBar(progress / 100.0)
                } else {
                    hostWindow.setProgressBar(-1)
                }
                lastProgress = progress
            })
        })

        config.changed$.subscribe(() => {
            this.updateDarkMode()
            this.updateWindowControlsColor()
        })
    }

    private registerGlobalHotkey() {
        let value = this.config.store.hotkeys['toggle-window'] || []
        if (typeof value === 'string') {
            value = [value]
        }
        const specs: string[] = []
        value.forEach((item: string | string[]) => {
            item = typeof item === 'string' ? [item] : item

            try {
                let accelerator = item[0]
                accelerator = accelerator.replaceAll('Meta', 'Super')
                accelerator = accelerator.replaceAll('⌘', 'Command')
                accelerator = accelerator.replaceAll('⌥', 'Alt')
                accelerator = accelerator.replaceAll('-', '+')
                specs.push(accelerator)
            } catch (err) {
                console.error('Could not register the global hotkey:', err)
            }
        })

        for (const accelerator of specs) {
            ipc.app.RegisterGlobalHotkey({ accelerator, register: true })
        }
    }

    private updateVibrancy() {
        const vibrancyType = this.config.store.appearance.vibrancyType ?? null
        const vibrancyEnabled: boolean = !!this.config.store.appearance.vibrancy
        ipc.window.SetVibrancy({ enabled: vibrancyEnabled, type: vibrancyType ?? '' })
        this.hostWindow.setOpacity(this.config.store.appearance.opacity)
    }

    private updateDarkMode() {
        const colorSchemeMode = this.config.store.appearance.colorSchemeMode ?? ''
        ipc.window.SetDarkMode({ mode: colorSchemeMode })
    }

    private updateWindowControlsColor() {
        if (this.hostApp.platform === Platform.Windows && this.config.store.appearance.frame === 'native') {
            return
        }
        const colorScheme = JSON.stringify(this.config.store.terminal.colorScheme ?? {})
        ipc.window.SetWindowControlsColor({ value: colorScheme })
    }
}

export {
    MoBrowserHostWindow,
    MoBrowserHostAppService,
    AppConfigService,
}
