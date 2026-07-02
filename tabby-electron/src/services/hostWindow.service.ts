import { Injectable, Inject, NgZone } from '@angular/core'
import { BootstrapData, BOOTSTRAP_DATA, HostWindowService } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

export interface Bounds {
    x: number
    y: number
    width: number
    height: number
}

@Injectable({ providedIn: 'root' })
export class ElectronHostWindow extends HostWindowService {
    get isFullscreen (): boolean { return this._isFullscreen }

    private _isFullscreen = false
    private _isMaximized = false

    constructor (
        zone: NgZone,
        private electron: ElectronService,
        @Inject(BOOTSTRAP_DATA) private bootstrapData: BootstrapData,
    ) {
        super()
        electron.ipc.on('host:window-enter-full-screen', () => zone.run(() => {
            this._isFullscreen = true
        }))

        electron.ipc.on('host:window-leave-full-screen', () => zone.run(() => {
            this._isFullscreen = false
        }))

        electron.ipc.on('host:window-shown', () => zone.run(() => this.windowShown.next()))

        electron.ipc.on('host:window-close-request', () => zone.run(() => {
            this.windowCloseRequest.next()
        }))

        electron.ipc.on('host:window-moved', () => zone.run(() => {
            this.windowMoved.next()
        }))

        electron.ipc.on('host:window-focused', () => zone.run(() => {
            this.windowFocused.next()
        }))

        electron.ipc.on('host:became-main-window', () => zone.run(() => {
            this.bootstrapData.isMainWindow = true
        }))

        electron.ipc.on('host:window-maximized', () => zone.run(() => {
            this._isMaximized = true
        }))

        electron.ipc.on('host:window-unmaximized', () => zone.run(() => {
            this._isMaximized = false
        }))

    }

    getWindow (): any {
        return null
    }

    openDevTools (): void {
        this.electron.ipc.send('window-open-dev-tools')
    }

    reload (): void {
        this.electron.ipc.send('window-reload')
    }

    setTitle (title?: string): void {
        this.electron.ipc.send('window-set-title', title ?? 'Tabby')
    }

    toggleFullscreen (): void {
        this.electron.ipc.send('window-toggle-fullscreen')
    }

    minimize (): void {
        this.electron.ipc.send('window-minimize')
    }

    isMaximized (): boolean {
        return this._isMaximized
    }

    toggleMaximize (): void {
        this.electron.ipc.send('window-toggle-maximize')
    }

    close (): void {
        this.electron.ipc.send('window-close')
    }

    setBounds (bounds: Bounds): void {
        this.electron.ipc.send('window-set-bounds', bounds)
    }

    setAlwaysOnTop (flag: boolean): void {
        this.electron.ipc.send('window-set-always-on-top', flag)
    }

    setTouchBar (_touchBar: any): void {
        // TouchBar requires main-process BrowserWindow access; bridge not yet implemented
    }

    setTrafficLightPosition (x: number, y: number): void {
        this.electron.ipc.send('window-set-traffic-light-position', x, y)
    }

    setOpacity (opacity: number): void {
        this.electron.ipc.send('window-set-opacity', opacity)
    }

    setProgressBar (value: number): void {
        this.electron.ipc.send('window-set-progress-bar', value)
    }

    bringToFront (): void {
        this.electron.ipc.send('window-bring-to-front')
    }
}
