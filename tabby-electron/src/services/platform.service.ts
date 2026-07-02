import { Injectable, NgZone } from '@angular/core'
import { PlatformService, ClipboardContent, Platform, MenuItemOptions, MessageBoxOptions, MessageBoxResult, DirectoryUpload, FileUpload, FileDownload, DirectoryDownload, FileUploadOptions, wrapPromise, TranslateService, FileTransfer, PlatformTheme } from 'tabby-core'
import { ElectronService } from '../services/electron.service'
import { ShellIntegrationService } from './shellIntegration.service'
import { ElectronHostAppService } from './hostApp.service'

@Injectable({ providedIn: 'root' })
export class ElectronPlatformService extends PlatformService {
    supportsWindowControls = true
    private safeExternalSchemes = new Set(['http', 'https', 'ftp', 'mailto'])
    private configPath: string
    private _shouldUseDarkColors = true
    private _osRelease = ''

    constructor (
        private hostApp: ElectronHostAppService,
        private electron: ElectronService,
        private zone: NgZone,
        private shellIntegration: ShellIntegrationService,
        private translate: TranslateService,
    ) {
        super()
        // Derive config path from userDataPath exposed via contextBridge (no Node.js path needed)
        const userDataPath = (window as any).tabbyAPI?.userDataPath ?? ''
        this.configPath = userDataPath ? userDataPath + '/config.yaml' : ''

        electron.ipc.on('host:display-metrics-changed', () => {
            this.zone.run(() => this.displayMetricsChanged.next())
        })

        this.electron.ipc.invoke('bridge:os:release').then((r: string) => { this._osRelease = r })
        this.electron.getShouldUseDarkColors().then(v => { this._shouldUseDarkColors = v })
        this.electron.onNativeThemeUpdated(() => {
            this.electron.getShouldUseDarkColors().then(v => {
                this._shouldUseDarkColors = v
                this.zone.run(() => this.themeChanged.next(this.getTheme()))
            })
        })
    }

    async getAllFiles (dir: string, root: DirectoryUpload): Promise<DirectoryUpload> {
        const items: Array<{ name: string; isDirectory: boolean }> = await this.electron.ipc.invoke('bridge:fs:readdir', dir)
        for (const item of items) {
            if (item.isDirectory) {
                root.pushChildren(await this.getAllFiles(dir + '/' + item.name, new DirectoryUpload(item.name)))
            } else {
                const file = new ElectronFileUpload(dir + '/' + item.name, this.electron)
                root.pushChildren(file)
                await wrapPromise(this.zone, file.open())
                this.fileTransferStarted.next(file)
            }
        }
        return root
    }

    readClipboard (): string {
        return this.electron.clipboard.readText()
    }

    setClipboard (content: ClipboardContent): void {
        this.electron.clipboard.write(content)
    }

    async installPlugin (name: string, version: string): Promise<void> {
        await this.electron.ipc.invoke('plugin-manager:install', name, version)
    }

    async uninstallPlugin (name: string): Promise<void> {
        await this.electron.ipc.invoke('plugin-manager:uninstall', name)
    }

    async isProcessRunning (name: string): Promise<boolean> {
        if (this.hostApp.platform === Platform.Windows) {
            return this.electron.ipc.invoke('bridge:process:is-running', name)
        } else {
            throw new Error('Not supported')
        }
    }

    getWinSCPPath (): string|null {
        // Synchronous registry read is not available in the sandboxed renderer.
        // WinSCP integration is Windows-only and requires a separate async IPC call.
        return null
    }

    async exec (app: string, argv: string[]): Promise<void> {
        await this.electron.ipc.invoke('bridge:process:exec', app, argv)
    }

    isShellIntegrationSupported (): boolean {
        return this.hostApp.platform !== Platform.Linux
    }

    async isShellIntegrationInstalled (): Promise<boolean> {
        return this.shellIntegration.isInstalled()
    }

    async installShellIntegration (): Promise<void> {
        await this.shellIntegration.install()
    }

    async uninstallShellIntegration (): Promise<void> {
        await this.shellIntegration.remove()
    }

    async loadConfig (): Promise<string> {
        return this.electron.ipc.invoke('bridge:config:read-raw')
    }

    async saveConfig (content: string): Promise<void> {
        await this.hostApp.saveConfig(content)
    }

    getConfigPath (): string|null {
        return this.configPath
    }

    showItemInFolder (p: string): void {
        this.electron.shell.showItemInFolder(p)
    }

    async openExternal (url: string): Promise<void> {
        const scheme = this.getExternalScheme(url)
        if (scheme && this.safeExternalSchemes.has(scheme)) {
            await this.electron.shell.openExternal(url)
        } else {
            await this.confirmAndOpenExternal(url)
        }
    }

    private getExternalScheme (url: string): string | null {
        try {
            const protocol = new URL(url.trim()).protocol
            return protocol ? protocol.replace(':', '').toLowerCase() : null
        } catch {
            return null
        }
    }

    private async confirmAndOpenExternal (url: string): Promise<void> {
        const scheme = this.getExternalScheme(url)
        const result = await this.electron.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(`Open this app-specific "${scheme}" URI?`),
                detail: url,
                buttons: [
                    this.translate.instant('Open'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )

        if (result.response === 0) {
            await this.electron.shell.openExternal(url)
        }
    }

    openPath (p: string): void {
        this.electron.shell.openPath(p)
    }

    getOSRelease (): string {
        return this._osRelease
    }

    getAppVersion (): string {
        return this.electron.getAppVersion()
    }

    async listFonts (): Promise<string[]> {
        return this.electron.ipc.invoke('bridge:fonts:list')
    }

    async popupContextMenu (menu: MenuItemOptions[], _event?: MouseEvent): Promise<void> {
        await this.electron.popupMenu(menu.map(item => this.rewrapMenuItemOptions(item)))
    }

    rewrapMenuItemOptions (menu: MenuItemOptions): MenuItemOptions {
        return {
            ...menu,
            click: () => {
                this.zone.run(() => {
                    menu.click?.()
                })
            },
            submenu: menu.submenu ? menu.submenu.map(x => this.rewrapMenuItemOptions(x)) : undefined,
        }
    }

    async showMessageBox (options: MessageBoxOptions): Promise<MessageBoxResult> {
        return this.electron.showMessageBox(options)
    }

    quit (): void {
        this.electron.exit(0)
    }

    async startUpload (options?: FileUploadOptions, paths?: string[]): Promise<FileUpload[]> {
        options ??= { multiple: false }

        const properties: any[] = ['openFile', 'treatPackageAsDirectory']
        if (options.multiple) {
            properties.push('multiSelections')
        }

        if (!paths) {
            const result = await this.electron.showOpenDialog(
                {
                    buttonLabel: this.translate.instant('Select'),
                    properties,
                },
            )
            if (result.canceled) {
                return []
            }
            paths = result.filePaths ?? []
        }

        return Promise.all(paths!.map(async p => {
            const transfer = new ElectronFileUpload(p, this.electron)
            await wrapPromise(this.zone, transfer.open())
            this.fileTransferStarted.next(transfer)
            return transfer
        }))
    }

    async startUploadDirectory (paths?: string[]): Promise<DirectoryUpload> {
        const properties: any[] = ['openFile', 'treatPackageAsDirectory', 'openDirectory']

        if (!paths) {
            const result = await this.electron.showOpenDialog(
                {
                    buttonLabel: this.translate.instant('Select'),
                    properties,
                },
            )
            if (result.canceled) {
                return new DirectoryUpload()
            }
            paths = result.filePaths ?? []
        }

        const root = new DirectoryUpload()
        const sep: string = await this.electron.ipc.invoke('bridge:path:sep')
        const posixSep: string = await this.electron.ipc.invoke('bridge:path:posix-sep')
        const baseName: string = await this.electron.ipc.invoke('bridge:path:basename', paths![0])
        const normalizedPath = paths![0].split(sep).join(posixSep)
        root.pushChildren(await this.getAllFiles(normalizedPath, new DirectoryUpload(baseName)))
        return root
    }

    async startDownload (name: string, mode: number, size: number, filePath?: string): Promise<FileDownload|null> {
        if (!filePath) {
            const result = await this.electron.showSaveDialog(
                {
                    defaultPath: name,
                },
            )
            if (!result.filePath) {
                return null
            }
            filePath = result.filePath ?? ''
        }
        const transfer = new ElectronFileDownload(filePath!, mode, size, this.electron)
        await wrapPromise(this.zone, transfer.open())
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    async startDownloadDirectory (name: string, estimatedSize?: number): Promise<DirectoryDownload|null> {
        const selectedFolder = await this.pickDirectory(this.translate.instant('Select destination folder for {name}', { name }), this.translate.instant('Download here'))
        if (!selectedFolder) {
            return null
        }

        let downloadPath = selectedFolder + '/' + name
        let counter = 1
        while (await this.electron.ipc.invoke('bridge:fs:exists', downloadPath)) {
            downloadPath = selectedFolder + '/' + name + ' (' + counter + ')'
            counter++
        }

        const transfer = new ElectronDirectoryDownload(downloadPath, name, estimatedSize ?? 0, this.electron, this.zone)
        await wrapPromise(this.zone, transfer.open())
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    _registerFileTransfer (transfer: FileTransfer): void {
        this.fileTransferStarted.next(transfer)
    }

    setErrorHandler (handler: (_: any) => void): void {
        this.electron.ipc.on('uncaughtException', (err) => {
            handler(err)
        })
    }

    async pickDirectory (title?: string, buttonLabel?: string): Promise<string | null> {
        const result = await this.electron.showOpenDialog(
            {
                title,
                buttonLabel,
                properties: ['openDirectory', 'showHiddenFiles'],
            },
        )
        if (result.canceled || !result.filePaths.length) {
            return null
        }
        return result.filePaths[0]
    }

    getTheme (): PlatformTheme {
        return this._shouldUseDarkColors ? 'dark' : 'light'
    }
}

class ElectronFileUpload extends FileUpload {
    private size: number
    private mode: number
    private handleId: number
    private buffer: Uint8Array
    private powerSaveBlocker: Promise<number>

    constructor (private filePath: string, private electron: ElectronService) {
        super()
        this.buffer = new Uint8Array(256 * 1024)
        this.powerSaveBlocker = electron.startPowerSaveBlocker('prevent-app-suspension')
    }

    async open (): Promise<void> {
        const stat: { size: number; mode: number; isDirectory: boolean } = await this.electron.ipc.invoke('bridge:fs:stat', this.filePath)
        this.size = stat.size
        this.mode = stat.mode
        this.setTotalSize(this.size)
        this.handleId = await this.electron.ipc.invoke('bridge:fs:open', this.filePath, 'r')
    }

    getName (): string {
        return this.filePath.replace(/\\/g, '/').split('/').pop() ?? ''
    }

    getMode (): number {
        return this.mode
    }

    getSize (): number {
        return this.size
    }

    async read (): Promise<Uint8Array> {
        const result: { data: Uint8Array; bytesRead: number } = await this.electron.ipc.invoke('bridge:fs:read-chunk', this.handleId, this.buffer.length)
        this.increaseProgress(result.bytesRead)
        if (this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
        return new Uint8Array(result.data).slice(0, result.bytesRead)
    }

    close (): void {
        this.powerSaveBlocker.then(id => this.electron.stopPowerSaveBlocker(id))
        this.electron.ipc.invoke('bridge:fs:close', this.handleId)
    }
}

class ElectronFileDownload extends FileDownload {
    private handleId: number
    private powerSaveBlocker: Promise<number>

    constructor (
        private filePath: string,
        private mode: number,
        private size: number,
        private electron: ElectronService,
    ) {
        super()
        this.powerSaveBlocker = electron.startPowerSaveBlocker('prevent-app-suspension')
        this.setTotalSize(size)
    }

    async open (): Promise<void> {
        this.handleId = await this.electron.ipc.invoke('bridge:fs:open', this.filePath, 'w', this.mode)
    }

    getName (): string {
        return this.filePath.replace(/\\/g, '/').split('/').pop() ?? ''
    }

    getSize (): number {
        return this.size
    }

    async write (buffer: Uint8Array): Promise<void> {
        let pos = 0
        while (pos < buffer.length) {
            const bytesWritten: number = await this.electron.ipc.invoke('bridge:fs:write-chunk', this.handleId, buffer.slice(pos), pos)
            this.increaseProgress(bytesWritten)
            pos += bytesWritten
        }
        if (this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
    }

    close (): void {
        this.powerSaveBlocker.then(id => this.electron.stopPowerSaveBlocker(id))
        this.electron.ipc.invoke('bridge:fs:close', this.handleId)
    }
}

class ElectronDirectoryDownload extends DirectoryDownload {
    private powerSaveBlocker: Promise<number>

    constructor (
        private basePath: string,
        private name: string,
        estimatedSize: number,
        private electron: ElectronService,
        private zone: NgZone,
    ) {
        super()
        this.powerSaveBlocker = electron.startPowerSaveBlocker('prevent-app-suspension')
        this.setTotalSize(estimatedSize)
    }

    async open (): Promise<void> {
        await this.electron.ipc.invoke('bridge:fs:mkdir', this.basePath, { recursive: true })
    }

    getName (): string {
        return this.name
    }

    getSize (): number {
        return this.getTotalSize()
    }

    async createDirectory (relativePath: string): Promise<void> {
        const fullPath = this.basePath + '/' + relativePath
        await this.electron.ipc.invoke('bridge:fs:mkdir', fullPath, { recursive: true })
    }

    async createFile (relativePath: string, mode: number, size: number): Promise<FileDownload> {
        const fullPath = this.basePath + '/' + relativePath
        const dirName: string = await this.electron.ipc.invoke('bridge:path:dirname', fullPath)
        await this.electron.ipc.invoke('bridge:fs:mkdir', dirName, { recursive: true })

        const fileDownload = new ElectronFileDownload(fullPath, mode, size, this.electron)
        await wrapPromise(this.zone, fileDownload.open())
        return fileDownload
    }

    close (): void {
        this.powerSaveBlocker.then(id => this.electron.stopPowerSaveBlocker(id))
    }
}
