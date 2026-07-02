/**
 * Main-process IPC bridge.
 * Exposes main-process Electron APIs to the sandboxed renderer via ipcMain.handle.
 * All channels are prefixed with 'bridge:' to avoid collision with existing channels.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerSaveBlocker, screen } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { exec } from 'child_process'
import { execFile } from 'child_process'
import { configPath } from './config'

// ── Lazy-initialized winston logger for renderer log forwarding ───────────────
let _winstonLogger: any = null

function getWinstonLogger () {
    if (_winstonLogger) return _winstonLogger
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const winston = require('winston')
    const logFile = path.join(app.getPath('userData'), 'log.txt')
    _winstonLogger = winston.createLogger({
        transports: [
            new winston.transports.File({
                level: 'debug',
                filename: logFile,
                format: winston.format.simple(),
                handleExceptions: false,
                maxsize: 5242880,
                maxFiles: 5,
            }),
        ],
        exitOnError: false,
    })
    return _winstonLogger
}

// ── Shell integration registry keys (Windows) ─────────────────────────────────
const shellIntegrationRegistryKeys = [
    { path: 'Software\\Classes\\Directory\\Background\\shell\\Tabby', value: 'Open Tabby here', command: 'open "%V"' },
    { path: 'SOFTWARE\\Classes\\Directory\\shell\\Tabby', value: 'Open Tabby here', command: 'open "%V"' },
    { path: 'Software\\Classes\\*\\shell\\Tabby', value: 'Paste path into Tabby', command: 'paste "%V"' },
]

function buildMenuTemplate (items: any[], sender: Electron.WebContents): Electron.MenuItemConstructorOptions[] {
    return items.map(item => {
        const entry: Electron.MenuItemConstructorOptions = {}
        if (item.label !== undefined) { entry.label = item.label }
        if (item.type !== undefined) { entry.type = item.type }
        if (item.accelerator !== undefined) { entry.accelerator = item.accelerator }
        if (item.role !== undefined) { entry.role = item.role }
        if (item.enabled !== undefined) { entry.enabled = item.enabled }
        if (item.checked !== undefined) { entry.checked = item.checked }
        if (item.visible !== undefined) { entry.visible = item.visible }
        if (item.handlerId !== undefined) {
            const id = item.handlerId
            entry.click = () => {
                if (!sender.isDestroyed()) {
                    sender.send('bridge:menu:click', id)
                }
            }
        }
        if (item.submenu) {
            entry.submenu = buildMenuTemplate(item.submenu, sender)
        }
        return entry
    })
}

export function initBridge (): void {
    // ── app ──────────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:app:get-version', () => app.getVersion())
    ipcMain.handle('bridge:app:get-path', (_e, name: string) => app.getPath(name as any))
    ipcMain.handle('bridge:app:get-app-path', () => app.getAppPath())
    ipcMain.handle('bridge:app:relaunch', (_e, options?: { execPath?: string; args?: string[] }) => {
        app.relaunch(options)
    })
    ipcMain.handle('bridge:app:exit', (_e, code?: number) => app.exit(code))
    ipcMain.handle('bridge:app:quit', () => app.quit())
    ipcMain.handle('bridge:app:set-jump-list', (_e, categories: any[]) => {
        app.setJumpList(categories)
    })

    // ── screen ───────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:screen:get-all-displays', () => screen.getAllDisplays())
    ipcMain.handle('bridge:screen:get-primary-display', () => screen.getPrimaryDisplay())
    ipcMain.handle('bridge:screen:get-display-nearest-point', (_e, point: { x: number; y: number }) =>
        screen.getDisplayNearestPoint(point))
    ipcMain.handle('bridge:screen:get-cursor-screen-point', () => screen.getCursorScreenPoint())

    // ── dialog ───────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:dialog:show-open', (event, options: any) => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        return dialog.showOpenDialog(win, options)
    })
    ipcMain.handle('bridge:dialog:show-save', (event, options: any) => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        return dialog.showSaveDialog(win, options)
    })
    ipcMain.handle('bridge:dialog:show-message-box', (event, options: any) => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        return dialog.showMessageBox(win, options)
    })

    // ── nativeTheme ──────────────────────────────────────────────────────────
    ipcMain.handle('bridge:native-theme:get', () => ({
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    }))
    nativeTheme.on('updated', () => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('bridge:native-theme:updated')
            }
        }
    })

    // ── powerSaveBlocker ─────────────────────────────────────────────────────
    ipcMain.handle('bridge:power-save-blocker:start', (_e, type: 'prevent-app-suspension' | 'prevent-display-sleep') =>
        powerSaveBlocker.start(type))
    ipcMain.handle('bridge:power-save-blocker:stop', (_e, id: number) => powerSaveBlocker.stop(id))

    // ── config ────────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:config:read-raw', () => {
        try {
            return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
        } catch {
            return ''
        }
    })

    // ── fonts ─────────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:fonts:list', async () => {
        if (process.platform === 'linux') {
            return new Promise<string[]>((resolve) => {
                execFile('fc-list', [':spacing=mono'], (err, stdout) => {
                    if (err) { resolve([]); return }
                    const fonts = stdout.toString()
                        .split('\n').filter(x => !!x)
                        .map(x => x.split(':')[1]?.trim() ?? '')
                        .map(x => x.split(',')[0].trim())
                    fonts.sort()
                    resolve(fonts)
                })
            })
        }
        let fontManager: any
        try { fontManager = require('fontmanager-redux') } catch { return [] }
        const fonts = await new Promise<any[]>(resolve => fontManager.getAvailableFonts(resolve))
        return fonts.map((x: any) => x.family.trim())
    })

    // ── process ───────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:process:is-running', (_e, name: string) => {
        // Windows-only: delegate to main-process native module
        if (process.platform !== 'win32') { return false }
        try {
            const wptn = require('@tabby-gang/windows-process-tree/build/Release/windows_process_tree.node')
            return new Promise<boolean>(resolve => {
                wptn.getProcessList((list: any[]) => resolve(list.some(x => x.name === name)), 0)
            })
        } catch { return false }
    })

    ipcMain.handle('bridge:process:exec', (_e, app: string, argv: string[]) => {
        return new Promise<void>((resolve, reject) => {
            execFile(app, argv, err => err ? reject(err) : resolve())
        })
    })

    // ── menu / dock menu ─────────────────────────────────────────────────────
    ipcMain.handle('bridge:menu:popup', (event, items: any[]) => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        Menu.buildFromTemplate(buildMenuTemplate(items, event.sender)).popup({ window: win })
    })

    ipcMain.handle('bridge:dock:set-menu', (event, items: any[]) => {
        if (process.platform !== 'darwin' || !app.dock) {
            return
        }
        app.dock.setMenu(Menu.buildFromTemplate(buildMenuTemplate(items, event.sender)))
    })

    // ── logging (fire-and-forget from renderer) ───────────────────────────────
    ipcMain.on('bridge:log', (_e, level: string, name: string, args: any[]) => {
        try {
            const logger = getWinstonLogger()
            const logFn = logger[level] ?? logger.info
            logFn.call(logger, `[${name}]`, ...args)
        } catch { /* swallow errors to avoid IPC feedback loops */ }
    })

    // ── shell integration ─────────────────────────────────────────────────────
    ipcMain.handle('bridge:shell-integration:get-exe', () => {
        return process.env.PORTABLE_EXECUTABLE_FILE ?? null
    })

    ipcMain.handle('bridge:shell-integration:is-installed', async (_e, platform: string) => {
        if (platform === 'win32') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const wnr = require('windows-native-registry')
                return !!wnr.getRegistryKey(wnr.HK.CU, shellIntegrationRegistryKeys[0].path)
            } catch {
                return false
            }
        } else if (platform === 'darwin') {
            const workflowsLocation = path.join(
                path.dirname(path.dirname(app.getPath('exe'))),
                'Resources', 'extras', 'automator-workflows',
            )
            const dest = path.join(os.homedir(), 'Library', 'Services')
            return fs.existsSync(path.join(dest, 'Open Tabby here.workflow')) ||
                   fs.existsSync(path.join(workflowsLocation, 'Open Tabby here.workflow'))
        }
        return true
    })

    ipcMain.handle('bridge:shell-integration:install', async (_e, platform: string) => {
        if (platform === 'darwin') {
            const workflowsLocation = path.join(
                path.dirname(path.dirname(app.getPath('exe'))),
                'Resources', 'extras', 'automator-workflows',
            )
            const dest = path.join(os.homedir(), 'Library', 'Services')
            const workflows = ['Open Tabby here.workflow', 'Paste path into Tabby.workflow']
            await Promise.all(workflows.map(wf => new Promise<void>((resolve, reject) => {
                exec(`cp -r "${workflowsLocation}/${wf}" "${dest}"`, err => err ? reject(err) : resolve())
            })))
        } else if (platform === 'win32') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const wnr = require('windows-native-registry')
                const exe: string = process.env.PORTABLE_EXECUTABLE_FILE ?? app.getPath('exe')
                for (const registryKey of shellIntegrationRegistryKeys) {
                    wnr.createRegistryKey(wnr.HK.CU, registryKey.path)
                    wnr.createRegistryKey(wnr.HK.CU, registryKey.path + '\\command')
                    wnr.setRegistryValue(wnr.HK.CU, registryKey.path, '', wnr.REG.SZ, registryKey.value)
                    wnr.setRegistryValue(wnr.HK.CU, registryKey.path, 'Icon', wnr.REG.SZ, exe)
                    wnr.setRegistryValue(wnr.HK.CU, registryKey.path + '\\command', '', wnr.REG.SZ, exe + ' ' + registryKey.command)
                }
                if (wnr.getRegistryKey(wnr.HK.CU, 'Software\\Classes\\Directory\\Background\\shell\\Open Tabby here')) {
                    wnr.deleteRegistryKey(wnr.HK.CU, 'Software\\Classes\\Directory\\Background\\shell\\Open Tabby here')
                }
                if (wnr.getRegistryKey(wnr.HK.CU, 'Software\\Classes\\*\\shell\\Paste path into Tabby')) {
                    wnr.deleteRegistryKey(wnr.HK.CU, 'Software\\Classes\\*\\shell\\Paste path into Tabby')
                }
            } catch { /* wnr not available on non-Windows */ }
        }
    })

    ipcMain.handle('bridge:shell-integration:remove', async (_e, platform: string) => {
        if (platform === 'darwin') {
            const dest = path.join(os.homedir(), 'Library', 'Services')
            const workflows = ['Open Tabby here.workflow', 'Paste path into Tabby.workflow']
            await Promise.all(workflows.map(wf => new Promise<void>((resolve, reject) => {
                exec(`rm -rf "${dest}/${wf}"`, err => err ? reject(err) : resolve())
            })))
        } else if (platform === 'win32') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const wnr = require('windows-native-registry')
                for (const registryKey of shellIntegrationRegistryKeys) {
                    wnr.deleteRegistryKey(wnr.HK.CU, registryKey.path)
                }
            } catch { /* wnr not available on non-Windows */ }
        }
    })

    // ── os ────────────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:os:release', () => os.release())

    // ── file I/O ──────────────────────────────────────────────────────────────
    ipcMain.handle('bridge:file:read', async (_e, filePath: string) => {
        return fs.promises.readFile(filePath)
    })

    ipcMain.handle('bridge:file:write', async (_e, filePath: string, data: string | Uint8Array) => {
        await fs.promises.writeFile(filePath, data)
    })

    ipcMain.handle('bridge:fs:stat', async (_e, filePath: string) => {
        const stat = await fs.promises.stat(filePath)
        return { size: stat.size, mode: stat.mode, isDirectory: stat.isDirectory() }
    })

    ipcMain.handle('bridge:fs:exists', (_e, filePath: string) => {
        return fs.existsSync(filePath)
    })

    ipcMain.handle('bridge:fs:readdir', async (_e, dirPath: string) => {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
    })

    ipcMain.handle('bridge:fs:mkdir', async (_e, dirPath: string, options?: { recursive?: boolean }) => {
        await fs.promises.mkdir(dirPath, options)
    })

    // Streaming file handles: map handle IDs to open fs.promises.FileHandle instances
    const _fileHandles = new Map<number, fs.promises.FileHandle>()
    let _fileHandleCounter = 0

    ipcMain.handle('bridge:fs:open', async (_e, filePath: string, flags: string, mode?: number) => {
        const handle = await fs.promises.open(filePath, flags, mode)
        const id = _fileHandleCounter++
        _fileHandles.set(id, handle)
        return id
    })

    ipcMain.handle('bridge:fs:read-chunk', async (_e, handleId: number, length: number) => {
        const handle = _fileHandles.get(handleId)
        if (!handle) { throw new Error('Invalid file handle') }
        const buf = Buffer.allocUnsafe(length)
        const result = await handle.read(buf, 0, length, null)
        return { data: buf.slice(0, result.bytesRead), bytesRead: result.bytesRead }
    })

    ipcMain.handle('bridge:fs:write-chunk', async (_e, handleId: number, data: Uint8Array, offset: number) => {
        const handle = _fileHandles.get(handleId)
        if (!handle) { throw new Error('Invalid file handle') }
        const result = await handle.write(data, 0, data.length - offset, null)
        return result.bytesWritten
    })

    ipcMain.handle('bridge:fs:close', async (_e, handleId: number) => {
        const handle = _fileHandles.get(handleId)
        if (handle) {
            _fileHandles.delete(handleId)
            await handle.close()
        }
    })

    ipcMain.handle('bridge:path:basename', (_e, p: string) => path.basename(p))
    ipcMain.handle('bridge:path:dirname', (_e, p: string) => path.dirname(p))
    ipcMain.handle('bridge:path:join', (_e, ...parts: string[]) => path.join(...parts))
    ipcMain.handle('bridge:path:sep', () => path.sep)
    ipcMain.handle('bridge:path:posix-sep', () => path.posix.sep)

    // Hyper theme discovery runs in the main process because it requires Node.js
    // `require()` to load plugin modules from the filesystem.
    ipcMain.handle('bridge:hyper:get-color-schemes', async () => {
        const homeDir = os.homedir()
        const pluginsPath = path.join(homeDir, '.hyper_plugins', 'node_modules')
        if (!fs.existsSync(pluginsPath)) { return [] }
        let plugins: string[]
        try {
            plugins = await fs.promises.readdir(pluginsPath)
        } catch {
            return []
        }
        const themes: any[] = []
        for (const plugin of plugins) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const mod = require(path.join(pluginsPath, plugin))
                if (!mod.decorateConfig) { continue }
                let config: any = {}
                try { config = mod.decorateConfig({}) } catch { continue }
                if (!config.colors) { continue }
                themes.push({
                    name: plugin,
                    foreground: config.foregroundColor,
                    background: config.backgroundColor,
                    cursor: config.cursorColor,
                    colors: config.colors.black ? [
                        config.colors.black, config.colors.red, config.colors.green,
                        config.colors.yellow, config.colors.blue, config.colors.magenta,
                        config.colors.cyan, config.colors.white, config.colors.lightBlack,
                        config.colors.lightRed, config.colors.lightGreen, config.colors.lightYellow,
                        config.colors.lightBlue, config.colors.lightMagenta, config.colors.lightCyan,
                        config.colors.lightWhite,
                    ] : config.colors,
                })
            } catch {
                // Plugin failed to load — skip it
            }
        }
        return themes
    })
}
