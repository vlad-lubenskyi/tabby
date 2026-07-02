import { Injectable } from '@angular/core'

let _menuHandlerCounter = 0
const _menuHandlers = new Map<number, () => void>()

function serializeMenuItems (items: any[]): any[] {
    return items.map(item => {
        const entry: any = {}
        if (item.label !== undefined) { entry.label = item.label }
        if (item.type !== undefined) { entry.type = item.type }
        if (item.accelerator !== undefined) { entry.accelerator = item.accelerator }
        if (item.role !== undefined) { entry.role = item.role }
        if (item.enabled !== undefined) { entry.enabled = item.enabled }
        if (item.checked !== undefined) { entry.checked = item.checked }
        if (item.visible !== undefined) { entry.visible = item.visible }
        if (item.click) {
            entry.handlerId = _menuHandlerCounter++
            _menuHandlers.set(entry.handlerId, item.click)
        }
        if (item.submenu) {
            entry.submenu = serializeMenuItems(item.submenu)
        }
        return entry
    })
}

@Injectable({ providedIn: 'root' })
export class ElectronService {
    ipc: {
        send(channel: string, ...args: any[]): void
        invoke(channel: string, ...args: any[]): Promise<any>
        on(channel: string, listener: (...args: any[]) => void): () => void
        once(channel: string, listener: (...args: any[]) => void): void
        off(channel: string, listener: (...args: any[]) => void): void
    }
    shell: {
        openExternal(url: string): Promise<void>
        showItemInFolder(path: string): void
        openPath(path: string): Promise<string>
    }
    clipboard: {
        readText(): string
        write(content: any): void
    }

    /** @hidden */
    constructor () {
        const api = (window as any).tabbyAPI
        this.ipc = api.ipc
        this.shell = api.shell
        this.clipboard = api.clipboard

        // Forward menu click events from main to the registered handlers
        this.ipc.on('bridge:menu:click', (handlerId: number) => {
            _menuHandlers.get(handlerId)?.()
        })
    }

    // ── sync preloaded values ─────────────────────────────────────────────
    /** Synchronous — value is embedded in the preload before the renderer starts. */
    get appVersion (): string { return (window as any).tabbyAPI.appVersion }
    get userDataPath (): string { return (window as any).tabbyAPI.userDataPath }
    get exePath (): string { return (window as any).tabbyAPI.exePath }
    get appPath (): string { return (window as any).tabbyAPI.appPath }
    get arch (): string { return (window as any).tabbyAPI.arch }
    get platform (): string { return (window as any).tabbyAPI.platform }
    get devMode (): boolean { return (window as any).tabbyAPI.devMode }
    get portableExecutableFile (): string | null { return (window as any).tabbyAPI.portableExecutableFile }
    get env (): Record<string, string | null> { return (window as any).tabbyAPI.env }

    // ── app ──────────────────────────────────────────────────────────────
    getAppVersion (): string {
        return this.appVersion
    }

    getPath (name: string): Promise<string> {
        return this.ipc.invoke('bridge:app:get-path', name)
    }

    getAppPath (): Promise<string> {
        return this.ipc.invoke('bridge:app:get-app-path')
    }

    relaunch (options?: { execPath?: string; args?: string[] }): Promise<void> {
        return this.ipc.invoke('bridge:app:relaunch', options)
    }

    exit (code?: number): Promise<void> {
        return this.ipc.invoke('bridge:app:exit', code)
    }

    quit (): Promise<void> {
        return this.ipc.invoke('bridge:app:quit')
    }

    setJumpList (categories: any[]): Promise<void> {
        return this.ipc.invoke('bridge:app:set-jump-list', categories)
    }

    // ── screen ───────────────────────────────────────────────────────────
    getAllDisplays (): Promise<any[]> {
        return this.ipc.invoke('bridge:screen:get-all-displays')
    }

    getPrimaryDisplay (): Promise<any> {
        return this.ipc.invoke('bridge:screen:get-primary-display')
    }

    getDisplayNearestPoint (point: { x: number; y: number }): Promise<any> {
        return this.ipc.invoke('bridge:screen:get-display-nearest-point', point)
    }

    getCursorScreenPoint (): Promise<{ x: number; y: number }> {
        return this.ipc.invoke('bridge:screen:get-cursor-screen-point')
    }

    // ── dialog ───────────────────────────────────────────────────────────
    showOpenDialog (options: any): Promise<any> {
        return this.ipc.invoke('bridge:dialog:show-open', options)
    }

    showSaveDialog (options: any): Promise<any> {
        return this.ipc.invoke('bridge:dialog:show-save', options)
    }

    showMessageBox (options: any): Promise<any> {
        return this.ipc.invoke('bridge:dialog:show-message-box', options)
    }

    // ── nativeTheme ──────────────────────────────────────────────────────
    getShouldUseDarkColors (): Promise<boolean> {
        return this.ipc.invoke('bridge:native-theme:get').then((r: any) => r.shouldUseDarkColors)
    }

    onNativeThemeUpdated (cb: () => void): () => void {
        return this.ipc.on('bridge:native-theme:updated', cb)
    }

    // ── powerSaveBlocker ─────────────────────────────────────────────────
    startPowerSaveBlocker (type: 'prevent-app-suspension' | 'prevent-display-sleep'): Promise<number> {
        return this.ipc.invoke('bridge:power-save-blocker:start', type)
    }

    stopPowerSaveBlocker (id: number): Promise<void> {
        return this.ipc.invoke('bridge:power-save-blocker:stop', id)
    }

    // ── menu ─────────────────────────────────────────────────────────────
    popupMenu (items: any[]): Promise<void> {
        return this.ipc.invoke('bridge:menu:popup', serializeMenuItems(items))
    }

    setDockMenu (items: any[]): Promise<void> {
        return this.ipc.invoke('bridge:dock:set-menu', serializeMenuItems(items))
    }
}
