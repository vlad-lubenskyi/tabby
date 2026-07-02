import { Injectable, NgZone, Inject } from '@angular/core'
import { ConfigService, DockingService, Screen, PlatformService, BootstrapData, BOOTSTRAP_DATA } from 'tabby-core'

interface DisplayInfo {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    workArea: { x: number; y: number; width: number; height: number }
}
import { ElectronService } from '../services/electron.service'
import { ElectronHostWindow, Bounds } from './hostWindow.service'

@Injectable()
export class ElectronDockingService extends DockingService {
    private _screensCache: Screen[] = []

    constructor (
        private electron: ElectronService,
        private config: ConfigService,
        private zone: NgZone,
        private hostWindow: ElectronHostWindow,
        platform: PlatformService,
        @Inject(BOOTSTRAP_DATA) private bootstrapData: BootstrapData,
    ) {
        super()
        this.screensChanged$.subscribe(() => this.repositionWindow())
        platform.displayMetricsChanged$.subscribe(() => this.repositionWindow())

        electron.ipc.on('host:displays-changed', () => {
            this.zone.run(() => {
                this._refreshScreensCache()
                this.screensChanged.next()
            })
        })

        // Populate cache immediately
        this._refreshScreensCache()
    }

    private _refreshScreensCache (): void {
        this._getScreensAsync().then(screens => {
            this._screensCache = screens
        })
    }

    private async _getScreensAsync (): Promise<Screen[]> {
        const primaryDisplayID = (await this.electron.getPrimaryDisplay()).id
        return (await this.electron.getAllDisplays()).sort((a, b) =>
            a.bounds.x === b.bounds.x ? a.bounds.y - b.bounds.y : a.bounds.x - b.bounds.x,
        ).map((display, index) => ({
            ...display,
            id: display.id,
            name: display.id === primaryDisplayID ? 'Primary Display' : `Display ${index + 1}`,
        }))
    }

    async dock (): Promise<void> {
        const dockSide = this.config.store.appearance.dock

        if (dockSide === 'off' || !this.bootstrapData.isMainWindow) {
            this.hostWindow.setAlwaysOnTop(false)
            return
        }

        let display = (await this.electron.getAllDisplays())
            .filter(x => x.id === this.config.store.appearance.dockScreen)[0]
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!display) {
            display = await this.getCurrentScreen()
        }

        const newBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

        const fill = this.config.store.appearance.dockFill <= 1 ? this.config.store.appearance.dockFill : 1
        const space = this.config.store.appearance.dockSpace <= 1 ? this.config.store.appearance.dockSpace : 1
        const minWidth = 0
        const minHeight = 0

        if (dockSide === 'left' || dockSide === 'right') {
            newBounds.width = Math.max(minWidth, Math.round(fill * display.workArea.width))
            newBounds.height = Math.round(display.workArea.height * space)
        }
        if (dockSide === 'top' || dockSide === 'bottom') {
            newBounds.width = Math.round(display.workArea.width * space)
            newBounds.height = Math.max(minHeight, Math.round(fill * display.workArea.height))
        }
        if (dockSide === 'right') {
            newBounds.x = display.workArea.x + display.workArea.width - newBounds.width
        } else if (dockSide === 'left') {
            newBounds.x = display.workArea.x
        } else {
            newBounds.x = display.workArea.x + Math.round(display.workArea.width / 2 * (1 - space))
        }
        if (dockSide === 'bottom') {
            newBounds.y = display.workArea.y + display.workArea.height - newBounds.height
        } else if (dockSide === 'top') {
            newBounds.y = display.workArea.y
        } else {
            newBounds.y = display.workArea.y + Math.round(display.workArea.height / 2 * (1 - space))
        }

        const alwaysOnTop = this.config.store.appearance.dockAlwaysOnTop

        this.hostWindow.setAlwaysOnTop(alwaysOnTop)
        setTimeout(() => {
            this.hostWindow.setBounds(newBounds)
        }, 0)
    }

    getScreens (): Screen[] {
        return this._screensCache
    }

    private async getCurrentScreen (): Promise<DisplayInfo> {
        return this.electron.getDisplayNearestPoint(await this.electron.getCursorScreenPoint())
    }

    private async repositionWindow (): Promise<void> {
        const cursorPoint = await this.electron.getCursorScreenPoint()
        for (const screen of await this.electron.getAllDisplays()) {
            const bounds = screen.bounds
            if (cursorPoint.x >= bounds.x && cursorPoint.x <= bounds.x + bounds.width && cursorPoint.y >= bounds.y && cursorPoint.y <= bounds.y + bounds.height) {
                return
            }
        }
        const screen = await this.electron.getPrimaryDisplay()
        this.electron.ipc.send('window-set-position', screen.bounds.x, screen.bounds.y)
    }
}
