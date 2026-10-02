// Derived from: tabby-electron/src/services/hostWindow.service.ts
import { Injectable, NgZone } from '@angular/core'
import { HostWindowService } from 'tabby-core'
import { from } from 'rxjs'
import { ipc } from '@gen/ipc'

export interface Bounds {
    x: number
    y: number
    width: number
    height: number
}

@Injectable({ providedIn: 'root' })
export class MoBrowserHostWindow extends HostWindowService {
    get isFullscreen(): boolean { return this._isFullscreen }

    private _isFullscreen = false
    private _isMaximized = false

    constructor(zone: NgZone) {
        super()

        from(ipc.window.OnEnterFullScreen({})).subscribe(() => zone.run(() => {
            this._isFullscreen = true
        }))

        from(ipc.window.OnLeaveFullScreen({})).subscribe(() => zone.run(() => {
            this._isFullscreen = false
        }))

        from(ipc.window.OnShown({})).subscribe(() => zone.run(() => this.windowShown.next()))

        from(ipc.window.OnCloseRequest({})).subscribe(() => zone.run(() => {
            this.windowCloseRequest.next()
        }))

        from(ipc.window.OnMoved({})).subscribe(() => zone.run(() => {
            this.windowMoved.next()
        }))

        from(ipc.window.OnFocused({})).subscribe(() => zone.run(() => {
            this.windowFocused.next()
        }))

        from(ipc.window.OnMaximized({})).subscribe(() => zone.run(() => {
            this._isMaximized = true
        }))

        from(ipc.window.OnUnmaximized({})).subscribe(() => zone.run(() => {
            this._isMaximized = false
        }))
    }

    openDevTools(): void {
        ipc.window.OpenDevTools({})
    }

    reload(): void {
        ipc.window.Reload({})
    }

    setTitle(title?: string): void {
        ipc.window.SetTitle({ title: title ?? 'Tabby' })
    }

    toggleFullscreen(): void {
        ipc.window.ToggleFullscreen({})
    }

    minimize(): void {
        ipc.window.Minimize({})
    }

    isMaximized(): boolean {
        return this._isMaximized
    }

    toggleMaximize(): void {
        ipc.window.ToggleMaximize({})
    }

    close(): void {
        ipc.window.Close({})
    }

    setBounds(bounds: Bounds): void {
        ipc.window.SetBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
    }

    setAlwaysOnTop(flag: boolean): void {
        ipc.window.SetAlwaysOnTop({ enabled: flag })
    }

    setTrafficLightPosition(x: number, y: number): void {
        ipc.window.SetTrafficLightPosition({ x, y })
    }

    setOpacity(opacity: number): void {
        ipc.window.SetOpacity({ opacity })
    }

    setProgressBar(value: number): void {
        ipc.window.SetProgressBar({ value })
    }

    bringToFront(): void {
        ipc.window.BringToFront({})
    }
}
