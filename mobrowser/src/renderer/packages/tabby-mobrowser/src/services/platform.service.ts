// Derived from: tabby-electron/src/services/platform.service.ts
import { Injectable, NgZone } from '@angular/core'
import {
    PlatformService,
    ClipboardContent,
    Platform,
    MenuItemOptions,
    MessageBoxOptions,
    MessageBoxResult,
    DirectoryUpload,
    FileUpload,
    FileDownload,
    DirectoryDownload,
    FileUploadOptions,
    wrapPromise,
    TranslateService,
    FileTransfer,
    PlatformTheme,
} from 'tabby-core'
import { from } from 'rxjs'
import { ipc } from '@gen/ipc'
import { MoBrowserHostAppService } from './hostApp.service'
import { AppConfigService } from './appConfig.service'
import { MenuItemDefinition } from '@gen/menu'

@Injectable({ providedIn: 'root' })
export class MoBrowserPlatformService extends PlatformService {
    supportsWindowControls = true
    private safeExternalSchemes = new Set(['http', 'https', 'ftp', 'mailto'])
    private _shouldUseDarkColors = true
    private _clipboardText = ''

    constructor(
        private hostApp: MoBrowserHostAppService,
        private appConfig: AppConfigService,
        private zone: NgZone,
        private translate: TranslateService,
    ) {
        super()

        ipc.theme.GetNativeTheme({}).then(theme => {
            this._shouldUseDarkColors = theme.shouldUseDarkColors
        })

        from(ipc.theme.OnNativeThemeUpdated({})).subscribe(theme => {
            this._shouldUseDarkColors = theme.shouldUseDarkColors
            this.zone.run(() => this.themeChanged.next(this.getTheme()))
        })
    }

    readClipboard(): string {
        // Clipboard is async in MoBrowser; return cached value and update asynchronously
        ipc.platform.ClipboardReadText({}).then(r => {
            this._clipboardText = r.value ?? ''
        })
        return this._clipboardText
    }

    setClipboard(content: ClipboardContent): void {
        ipc.platform.ClipboardWrite({ text: content.text ?? '', html: content.html ?? '' })
    }

    async installPlugin(name: string, version: string): Promise<void> {
        await ipc.app.InstallPlugin({ name, version })
    }

    async uninstallPlugin(name: string): Promise<void> {
        await ipc.app.UninstallPlugin({ name, version: '' })
    }

    async isProcessRunning(name: string): Promise<boolean> {
        if (this.hostApp.platform === Platform.Windows) {
            const result = await ipc.platform.IsProcessRunning({ pid: parseInt(name, 10) })
            return result.value ?? false
        }
        throw new Error('Not supported')
    }

    getWinSCPPath(): string | null {
        return null
    }

    async exec(app: string, argv: string[]): Promise<void> {
        await ipc.platform.ExecProcess({ file: app, args: argv, cwd: '', env: {} })
    }

    isShellIntegrationSupported(): boolean {
        return this.hostApp.platform !== Platform.Linux
    }

    async isShellIntegrationInstalled(): Promise<boolean> {
        const result = await ipc.shell.IsInstalled({ shell: this.hostApp.platform })
        return result.value ?? false
    }

    async installShellIntegration(): Promise<void> {
        await ipc.shell.Install({ shell: this.hostApp.platform })
    }

    async uninstallShellIntegration(): Promise<void> {
        await ipc.shell.Remove({ shell: this.hostApp.platform })
    }

    async loadConfig(): Promise<string> {
        try {
            const result = await ipc.fs.ReadFile({ path: this.getConfigPath() ?? '' })
            return new TextDecoder().decode(result.data)
        } catch {
            return ''
        }
    }

    async saveConfig(content: string): Promise<void> {
        await this.hostApp.saveConfig(content)
    }

    getConfigPath(): string | null {
        const userDataPath = this.appConfig.data?.userDataPath ?? ''
        return userDataPath ? userDataPath + '/config.yaml' : null
    }

    showItemInFolder(p: string): void {
        ipc.platform.OpenExternal({ url: 'file://' + p })
    }

    async openExternal(url: string): Promise<void> {
        const scheme = this.getExternalScheme(url)
        if (scheme && this.safeExternalSchemes.has(scheme)) {
            await ipc.platform.OpenExternal({ url })
        } else {
            await this.confirmAndOpenExternal(url)
        }
    }

    private getExternalScheme(url: string): string | null {
        try {
            const protocol = new URL(url.trim()).protocol
            return protocol ? protocol.replace(':', '').toLowerCase() : null
        } catch {
            return null
        }
    }

    private async confirmAndOpenExternal(url: string): Promise<void> {
        const scheme = this.getExternalScheme(url)
        const result = await this.showMessageBox({
            type: 'warning',
            message: this.translate.instant(`Open this app-specific "${scheme}" URI?`),
            detail: url,
            buttons: [
                this.translate.instant('Open'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 0,
            cancelId: 1,
        })
        if (result.response === 0) {
            await ipc.platform.OpenExternal({ url })
        }
    }

    openPath(p: string): void {
        ipc.platform.OpenExternal({ url: 'file://' + p })
    }

    getOSRelease(): string {
        return this.appConfig.data?.osRelease ?? ''
    }

    getAppVersion(): string {
        return this.appConfig.data?.appVersion ?? ''
    }

    async listFonts(): Promise<string[]> {
        const result = await ipc.platform.ListFonts({})
        return (result as any).fonts ?? []
    }

    async popupContextMenu(menu: MenuItemOptions[], _event?: MouseEvent): Promise<void> {
        const items = menu.map((item, i) => this.convertMenuItem(item, String(i)))
        const clicks = new Map<string, () => void>()
        this.collectClicks(menu, items, clicks)

        await new Promise<void>((resolve) => {
            const stream = ipc.menu.ShowContextMenu({ items })
            from(stream).subscribe({
                next: (event) => {
                    const handler = clicks.get(event.itemId)
                    if (handler) {
                        this.zone.run(() => handler())
                    }
                },
                complete: () => resolve(),
                error: () => resolve(),
            })
        })
    }

    private convertMenuItem(item: MenuItemOptions, id: string): MenuItemDefinition {
        return {
            id,
            label: item.label ?? '',
            enabled: item.enabled !== false,
            checked: item.checked ?? false,
            type: item.type ?? 'normal',
            submenu: (item.submenu ?? []).map((sub, i) => this.convertMenuItem(sub, `${id}.${i}`)),
        }
    }

    private collectClicks(
        options: MenuItemOptions[],
        defs: MenuItemDefinition[],
        map: Map<string, () => void>,
    ): void {
        for (let i = 0; i < options.length; i++) {
            if (options[i].click) {
                map.set(defs[i].id, options[i].click!)
            }
            if (options[i].submenu) {
                this.collectClicks(options[i].submenu!, defs[i].submenu, map)
            }
        }
    }

    async showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult> {
        const result = await ipc.dialog.ShowMessageBox({
            type: options.type ?? 'info',
            title: '',
            message: options.message,
            detail: options.detail ?? '',
            buttons: (options.buttons ?? []).map((label, i) => ({
                label,
                isDefault: i === (options.defaultId ?? 0),
                isCancel: i === (options.cancelId ?? -1),
            })),
            hasCheckbox: false,
            checkboxLabel: '',
        })
        return { response: result.response }
    }

    quit(): void {
        ipc.app.Exit({})
    }

    async startUpload(options?: FileUploadOptions, paths?: string[]): Promise<FileUpload[]> {
        options ??= { multiple: false }

        const properties: string[] = ['openFile', 'treatPackageAsDirectory']
        if (options.multiple) {
            properties.push('multiSelections')
        }

        if (!paths) {
            const result = await ipc.dialog.ShowOpenDialog({
                title: '',
                buttonLabel: this.translate.instant('Select'),
                properties,
                filters: [],
                defaultPath: '',
            })
            if (result.canceled) {
                return []
            }
            paths = result.filePaths ?? []
        }

        return Promise.all(paths!.map(async p => {
            const transfer = new MoBrowserFileUpload(p)
            await wrapPromise(this.zone, transfer.open())
            this.fileTransferStarted.next(transfer)
            return transfer
        }))
    }

    async startUploadDirectory(paths?: string[]): Promise<DirectoryUpload> {
        const properties: string[] = ['openFile', 'treatPackageAsDirectory', 'openDirectory']

        if (!paths) {
            const result = await ipc.dialog.ShowOpenDialog({
                title: '',
                buttonLabel: this.translate.instant('Select'),
                properties,
                filters: [],
                defaultPath: '',
            })
            if (result.canceled) {
                return new DirectoryUpload()
            }
            paths = result.filePaths ?? []
        }

        const root = new DirectoryUpload()
        const pathSep = this.appConfig.data?.pathSep ?? '/'
        const posixSep = this.appConfig.data?.posixPathSep ?? '/'
        const baseNameResult = await ipc.platform.PathBasename({ path: paths![0] })
        const normalizedPath = paths![0].split(pathSep).join(posixSep)
        root.pushChildren(await this.getAllFiles(normalizedPath, new DirectoryUpload(baseNameResult.value ?? '')))
        return root
    }

    async getAllFiles(dir: string, root: DirectoryUpload): Promise<DirectoryUpload> {
        const result = await ipc.fs.ReadDir({ path: dir })
        for (const name of result.entries) {
            const fullPath = dir + '/' + name
            const stat = await ipc.fs.Stat({ path: fullPath })
            if (stat.isDirectory) {
                root.pushChildren(await this.getAllFiles(fullPath, new DirectoryUpload(name)))
            } else {
                const file = new MoBrowserFileUpload(fullPath)
                root.pushChildren(file)
                await wrapPromise(this.zone, file.open())
                this.fileTransferStarted.next(file)
            }
        }
        return root
    }

    async startDownload(name: string, mode: number, size: number, filePath?: string): Promise<FileDownload | null> {
        if (!filePath) {
            const result = await ipc.dialog.ShowSaveDialog({
                title: '',
                defaultPath: name,
                filters: [],
            })
            if (!result.filePath) {
                return null
            }
            filePath = result.filePath ?? ''
        }
        const transfer = new MoBrowserFileDownload(filePath!, mode, size)
        await wrapPromise(this.zone, transfer.open())
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    async startDownloadDirectory(name: string, estimatedSize?: number): Promise<DirectoryDownload | null> {
        const selectedFolder = await this.pickDirectory()
        if (!selectedFolder) {
            return null
        }

        let downloadPath = selectedFolder + '/' + name
        let counter = 1
        while ((await ipc.fs.Exists({ path: downloadPath })).value) {
            downloadPath = selectedFolder + '/' + name + ' (' + counter + ')'
            counter++
        }

        const transfer = new MoBrowserDirectoryDownload(downloadPath, name, estimatedSize ?? 0, this.zone)
        await wrapPromise(this.zone, transfer.open())
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    _registerFileTransfer(transfer: FileTransfer): void {
        this.fileTransferStarted.next(transfer)
    }

    setErrorHandler(handler: (_: any) => void): void {
        from(ipc.app.OnUncaughtException({})).subscribe(err => {
            handler(new Error(err.message))
        })
    }

    async pickDirectory(title?: string, _buttonLabel?: string): Promise<string | null> {
        const result = await ipc.dialog.ShowOpenDialog({
            title: title ?? '',
            buttonLabel: '',
            properties: ['openDirectory', 'showHiddenFiles'],
            filters: [],
            defaultPath: '',
        })
        if (result.canceled || !result.filePaths.length) {
            return null
        }
        return result.filePaths[0]
    }

    getTheme(): PlatformTheme {
        return this._shouldUseDarkColors ? 'dark' : 'light'
    }
}

class MoBrowserFileUpload extends FileUpload {
    private size = 0
    private mode = 0o644
    private handleId = 0
    private buffer: Uint8Array

    constructor(private filePath: string) {
        super()
        this.buffer = new Uint8Array(256 * 1024)
    }

    async open(): Promise<void> {
        const stat = await ipc.fs.Stat({ path: this.filePath })
        this.size = stat.size
        this.setTotalSize(this.size)
        const result = await ipc.fs.OpenHandle({ path: this.filePath, flags: 'r', mode: 0 })
        this.handleId = result.handleId
    }

    getName(): string {
        return this.filePath.replace(/\\/g, '/').split('/').pop() ?? ''
    }

    getMode(): number {
        return this.mode
    }

    getSize(): number {
        return this.size
    }

    async read(): Promise<Uint8Array> {
        const result = await ipc.fs.ReadChunk({ handleId: this.handleId, length: this.buffer.length })
        const data = new Uint8Array(result.data)
        this.increaseProgress(data.length)
        if (result.eof || this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
        return data
    }

    close(): void {
        ipc.fs.CloseHandle({ handleId: this.handleId })
    }
}

class MoBrowserFileDownload extends FileDownload {
    private handleId = 0

    constructor(
        private filePath: string,
        private mode: number,
        private size: number,
    ) {
        super()
        this.setTotalSize(size)
    }

    async open(): Promise<void> {
        const result = await ipc.fs.OpenHandle({ path: this.filePath, flags: 'w', mode: this.mode })
        this.handleId = result.handleId
    }

    getName(): string {
        return this.filePath.replace(/\\/g, '/').split('/').pop() ?? ''
    }

    getSize(): number {
        return this.size
    }

    async write(buffer: Uint8Array): Promise<void> {
        let pos = 0
        while (pos < buffer.length) {
            await ipc.fs.WriteChunk({ handleId: this.handleId, data: buffer.slice(pos), offset: pos })
            const bytesWritten = buffer.length - pos
            this.increaseProgress(bytesWritten)
            pos += bytesWritten
            if (this.getCompletedBytes() >= this.getSize()) {
                this.setCompleted(true)
            }
        }
    }

    close(): void {
        ipc.fs.CloseHandle({ handleId: this.handleId })
    }
}

class MoBrowserDirectoryDownload extends DirectoryDownload {
    constructor(
        private basePath: string,
        private name: string,
        estimatedSize: number,
        private zone: NgZone,
    ) {
        super()
        this.setTotalSize(estimatedSize)
    }

    async open(): Promise<void> {
        await ipc.fs.Mkdir({ path: this.basePath, recursive: true })
    }

    getName(): string {
        return this.name
    }

    getSize(): number {
        return this.getTotalSize()
    }

    async createDirectory(relativePath: string): Promise<void> {
        const fullPath = this.basePath + '/' + relativePath
        await ipc.fs.Mkdir({ path: fullPath, recursive: true })
    }

    async createFile(relativePath: string, mode: number, size: number): Promise<FileDownload> {
        const fullPath = this.basePath + '/' + relativePath
        const dirnameResult = await ipc.platform.PathDirname({ path: fullPath })
        await ipc.fs.Mkdir({ path: dirnameResult.value ?? '', recursive: true })

        const fileDownload = new MoBrowserFileDownload(fullPath, mode, size)
        await wrapPromise(this.zone, fileDownload.open())
        return fileDownload
    }

    close(): void {
        // no power-save blocker needed in MoBrowser
    }
}
