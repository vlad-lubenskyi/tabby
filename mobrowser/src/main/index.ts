// Derived from: app/lib/index.ts, app/lib/bridge.ts, app/lib/pty.ts

import { app, BrowserWindow, ipc, clipboard, displays } from '@mobrowser/api'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as child_process from 'node:child_process'
import * as crypto from 'node:crypto'
import { createRequire } from 'node:module'
import * as pty from 'node-pty'
import type { StreamContext } from '@mobrowser/api'
import {
  AppServiceDescriptor,
  DialogServiceDescriptor,
  FsServiceDescriptor,
  KeychainServiceDescriptor,
  LogServiceDescriptor,
  MenuServiceDescriptor,
  PlatformServiceDescriptor,
  PowerServiceDescriptor,
  PtyServiceDescriptor,
  ScreenServiceDescriptor,
  ShellServiceDescriptor,
  SshServiceDescriptor,
  TelnetServiceDescriptor,
  ThemeServiceDescriptor,
  UpdaterServiceDescriptor,
  WindowServiceDescriptor,
} from './gen/ipc_service'
import { sshService } from './ssh'
import { keychainService } from './keychain'
import { telnetService } from './telnet'
import type { ConfigPayload, CliArgs, ErrorInfo } from './gen/app'
import type { MenuClickEvent } from './gen/menu'
import type { PtyDataChunk } from './gen/pty'
import type { DisplayInfo, DisplayList } from './gen/screen'
import type { NativeTheme } from './gen/theme'
import type { UpdateInfo, UpdateError } from './gen/updater'
import type { Empty } from './gen/google/protobuf/empty'

// ---------------------------------------------------------------------------
// Utility: AsyncQueue — bridge from event-based APIs to async iterables
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  private buffer: T[] = []
  private resolver: ((value: IteratorResult<T>) => void) | null = null
  private closed = false

  push(value: T): void {
    if (this.closed) return
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r({ value: undefined as any, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        return new Promise(resolve => { this.resolver = resolve })
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: PubSub — fan-out broadcast for streaming IPC events (M → R)
// ---------------------------------------------------------------------------

class PubSub<T> {
  private subscribers: Set<AsyncQueue<T>> = new Set()

  subscribe(ctx: StreamContext): AsyncIterable<T> {
    const queue = new AsyncQueue<T>()
    this.subscribers.add(queue)
    ctx.signal.addEventListener('abort', () => {
      queue.close()
      this.subscribers.delete(queue)
    })
    return queue
  }

  publish(value: T): void {
    for (const q of this.subscribers) {
      q.push(value)
    }
  }
}

// ---------------------------------------------------------------------------
// Application window
// ---------------------------------------------------------------------------

const win = new BrowserWindow()
win.browser.loadUrl(app.url)
win.setSize({ width: 1200, height: 800 })
win.centerWindow()
win.show()

// ---------------------------------------------------------------------------
// AppService
// ---------------------------------------------------------------------------

const onConfigChange = new PubSub<ConfigPayload>()
const onCliInvocation = new PubSub<CliArgs>()
const onUncaughtException = new PubSub<ErrorInfo>()
const onPreferencesRequested = new PubSub<Empty>()

process.on('uncaughtException', (err: Error) => {
  onUncaughtException.publish({ message: err.message, stack: err.stack ?? '' })
})

ipc.registerService(AppServiceDescriptor, {
  async GetBootstrapData() {
    const userDataPath = path.join(os.homedir(), '.tabby')
    return {
      appVersion: app.version,
      appPath: app.name,
      userDataPath,
      exePath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      pathSep: path.sep,
      posixPathSep: path.posix.sep,
      devMode: !app.packaged,
      resourcesPath: (process as any).resourcesPath ?? '',
      userPluginsPath: '',
      installedPlugins: [],
      env: process.env as Record<string, string>,
    }
  },

  async GetPath({ name }) {
    try {
      return { value: app.getPath(name as any) }
    } catch {
      return { value: '' }
    }
  },

  async SaveConfig({ data }) {
    const configDir = path.join(os.homedir(), '.tabby')
    await fs.promises.mkdir(configDir, { recursive: true })
    await fs.promises.writeFile(path.join(configDir, 'config.yaml'), data)
    return {}
  },

  async Relaunch() {
    app.restart()
    return {}
  },

  async Exit() {
    app.quit()
    return {}
  },

  async Quit() {
    app.quit()
    return {}
  },

  async NewWindow() {
    const newWin = new BrowserWindow()
    newWin.browser.loadUrl(app.url)
    newWin.setSize({ width: 1200, height: 800 })
    newWin.centerWindow()
    newWin.show()
    return {}
  },

  async SetJumpList() {
    // Stub: MoBrowser has no Jump List API equivalent
    return {}
  },

  async RegisterGlobalHotkey() {
    // Stub: GlobalShortcut API integration TBD
    return {}
  },

  async InstallPlugin() {
    // Stub: plugin management TBD
    return {}
  },

  async UninstallPlugin() {
    // Stub: plugin management TBD
    return {}
  },

  OnConfigChange(_req: Empty, ctx: StreamContext) {
    return onConfigChange.subscribe(ctx)
  },

  OnCliInvocation(_req: Empty, ctx: StreamContext) {
    return onCliInvocation.subscribe(ctx)
  },

  OnUncaughtException(_req: Empty, ctx: StreamContext) {
    return onUncaughtException.subscribe(ctx)
  },

  OnPreferencesRequested(_req: Empty, ctx: StreamContext) {
    return onPreferencesRequested.subscribe(ctx)
  },
})

// ---------------------------------------------------------------------------
// FsService
// ---------------------------------------------------------------------------

let nextHandleId = 1
const fileHandles = new Map<number, fs.promises.FileHandle>()

ipc.registerService(FsServiceDescriptor, {
  async ReadFile({ path: p }) {
    const data = await fs.promises.readFile(p)
    return { data: Buffer.from(data) }
  },

  async WriteFile({ path: p, data }) {
    await fs.promises.writeFile(p, data)
    return {}
  },

  async Stat({ path: p }) {
    const s = await fs.promises.stat(p)
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtimeMs,
    }
  },

  async Exists({ path: p }) {
    return { value: fs.existsSync(p) }
  },

  async ReadDir({ path: p }) {
    const entries = await fs.promises.readdir(p)
    return { entries }
  },

  async Mkdir({ path: p, recursive }) {
    await fs.promises.mkdir(p, { recursive })
    return {}
  },

  async OpenHandle({ path: p, flags, mode }, ctx) {
    const handle = await fs.promises.open(p, flags || 'r', mode || undefined)
    const handleId = nextHandleId++
    fileHandles.set(handleId, handle)
    ctx.signal.addEventListener('abort', () => {
      fileHandles.delete(handleId)
      handle.close().catch(() => {})
    })
    return { handleId }
  },

  async ReadChunk({ handleId, length }) {
    const handle = fileHandles.get(handleId)
    if (!handle) throw new Error(`Unknown handle: ${handleId}`)
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length)
    return {
      data: buf.slice(0, bytesRead),
      eof: bytesRead < length,
    }
  },

  async WriteChunk({ handleId, data, offset }) {
    const handle = fileHandles.get(handleId)
    if (!handle) throw new Error(`Unknown handle: ${handleId}`)
    await handle.write(data, 0, data.length, offset || null)
    return {}
  },

  async CloseHandle({ handleId }) {
    const handle = fileHandles.get(handleId)
    if (handle) {
      fileHandles.delete(handleId)
      await handle.close()
    }
    return {}
  },
})

// ---------------------------------------------------------------------------
// LogService
// ---------------------------------------------------------------------------

ipc.registerService(LogServiceDescriptor, {
  async Log({ level, message }) {
    const logger = (console as any)[level]
    if (typeof logger === 'function') {
      logger(message)
    } else {
      console.log(message)
    }
    return {}
  },
})

// ---------------------------------------------------------------------------
// PlatformService
// ---------------------------------------------------------------------------

ipc.registerService(PlatformServiceDescriptor, {
  async ListFonts() {
    // Stub: font enumeration requires a native module
    return { fonts: [] }
  },

  async IsProcessRunning({ pid }) {
    try {
      process.kill(pid, 0)
      return { value: true }
    } catch {
      return { value: false }
    }
  },

  async ExecProcess({ file, args, cwd, env }) {
    const result = child_process.spawnSync(file, args, {
      cwd: cwd || undefined,
      env: env ? { ...process.env, ...env } : undefined,
      encoding: 'utf8',
    })
    return {
      exitCode: result.status ?? -1,
      stdout: (result.stdout as string) ?? '',
      stderr: (result.stderr as string) ?? '',
    }
  },

  async GetColorSchemes() {
    // Stub: native color scheme enumeration TBD
    return { schemes: [] }
  },

  async OpenExternal({ url }) {
    // Stub: MoBrowser has no direct shell.openExternal in this API version
    // Future: use Desktop API when available in @mobrowser/api
    console.log('[OpenExternal] stub — url:', url)
    return {}
  },

  async ClipboardReadText() {
    return { value: clipboard.read('text/plain') }
  },

  async ClipboardWrite({ text, html }) {
    if (html) {
      clipboard.write('text/html', html)
    }
    if (text) {
      clipboard.write('text/plain', text)
    }
    return {}
  },

  async PathBasename({ path: p }) {
    return { value: path.basename(p) }
  },

  async PathDirname({ path: p }) {
    return { value: path.dirname(p) }
  },

  async PathJoin({ parts }) {
    return { value: path.join(...parts) }
  },

  async PathResolve({ path: p, cwd }) {
    const expanded = /^~(?=$|[/\\])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p
    return { value: cwd ? path.resolve(cwd, expanded) : expanded }
  },
})

// ---------------------------------------------------------------------------
// PtyService
// ---------------------------------------------------------------------------

const ptyMap = new Map<string, pty.IPty>()
const ptyPidMap = new Map<string, number>()
let ptyHelperPatched = false

ipc.registerService(PtyServiceDescriptor, {
  async Spawn({ file, args, env, cwd, cols, rows }) {
    if (!ptyHelperPatched && process.platform !== 'win32') {
      const require = createRequire(import.meta.url)
      const ptyEntry = require.resolve('node-pty')
      const native = require(path.join(path.dirname(ptyEntry), 'utils.js')).loadNativeModule('pty')
      const fork = native.module.fork
      native.module.fork = (...forkArgs: any[]) => {
        forkArgs[9] = path.join(app.getPath('appResources'), 'app/node_modules/node-pty/lib', native.dir, 'spawn-helper')
        return fork(...forkArgs)
      }
      ptyHelperPatched = true
    }
    const ptyProcess = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: env ? { ...process.env, ...env } as Record<string, string> : process.env as Record<string, string>,
    })
    const ptyId = crypto.randomUUID()
    ptyMap.set(ptyId, ptyProcess)
    ptyPidMap.set(ptyId, ptyProcess.pid)
    return { ptyId, pid: ptyProcess.pid }
  },

  async Exists({ ptyId }) {
    return { value: ptyMap.has(ptyId) }
  },

  async GetPid({ ptyId }) {
    return { value: ptyPidMap.get(ptyId) ?? 0 }
  },

  async Resize({ ptyId, cols, rows }) {
    ptyMap.get(ptyId)?.resize(cols, rows)
    return {}
  },

  async Write({ ptyId, data }) {
    ptyMap.get(ptyId)?.write(data.toString())
    return {}
  },

  async Kill({ ptyId, signal }) {
    const ptyProcess = ptyMap.get(ptyId)
    if (ptyProcess) {
      ptyProcess.kill(signal || undefined)
      ptyMap.delete(ptyId)
      ptyPidMap.delete(ptyId)
    }
    return {}
  },

  async GetChildProcesses() {
    // Stub: platform-specific enumeration TBD
    return { processes: [] }
  },

  async GetWorkingDirectory() {
    // Stub: requires /proc or platform-specific lsof TBD
    return { value: '' }
  },

  async *ReadData({ ptyId }, ctx: StreamContext) {
    const ptyProcess = ptyMap.get(ptyId)
    if (!ptyProcess) return

    const queue = new AsyncQueue<PtyDataChunk>()

    ptyProcess.onData((data: string) => {
      queue.push({ data: Buffer.from(data), isExit: false, exitCode: 0 })
    })

    ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      queue.push({ data: Buffer.alloc(0), isExit: true, exitCode: exitCode ?? 0 })
      queue.close()
      ptyMap.delete(ptyId)
      ptyPidMap.delete(ptyId)
    })

    ctx.signal.addEventListener('abort', () => {
      queue.close()
    })

    yield* queue
  },
})

// ---------------------------------------------------------------------------
// WindowService
// ---------------------------------------------------------------------------

const onShown = new PubSub<Empty>()
const onMoved = new PubSub<Empty>()
const onFocused = new PubSub<Empty>()
const onEnterFullScreen = new PubSub<Empty>()
const onLeaveFullScreen = new PubSub<Empty>()
const onMaximized = new PubSub<Empty>()
const onUnmaximized = new PubSub<Empty>()
const onCloseRequest = new PubSub<Empty>()
const onBecameMainWindow = new PubSub<Empty>()

win.on('shown', () => onShown.publish({}))
win.on('moved', () => onMoved.publish({}))
win.on('focused', () => onFocused.publish({}))
win.on('maximized', () => onMaximized.publish({}))
win.on('restored', () => onUnmaximized.publish({}))

win.handle('close', async () => {
  onCloseRequest.publish({})
  return 'hide'
})

ipc.registerService(WindowServiceDescriptor, {
  async Minimize() {
    win.minimize()
    return {}
  },

  async ToggleMaximize() {
    if (win.isMaximized) {
      win.restore()
    } else {
      win.maximize()
    }
    return {}
  },

  async BringToFront() {
    win.show()
    win.focus()
    return {}
  },

  async Close() {
    win.close()
    return {}
  },

  async SetBounds({ x, y, width, height }) {
    win.setBounds({ origin: { x, y }, size: { width, height } })
    return {}
  },

  async SetAlwaysOnTop({ enabled }) {
    win.setAlwaysOnTop(enabled)
    return {}
  },

  async SetTitle({ title }) {
    win.setTitle(title)
    return {}
  },

  async SetOpacity({ opacity }) {
    win.setOpacity(opacity)
    return {}
  },

  async SetProgressBar() {
    // Stub: MoBrowser has no progress bar window API in this version
    return {}
  },

  async SetTrafficLightPosition({ x, y }) {
    win.setWindowButtonPosition({ x, y })
    return {}
  },

  async SetVibrancy({ enabled, type }) {
    if (enabled) {
      win.setVibrancyEffect((type || 'sidebar') as any)
    } else {
      win.setVibrancyEffect('none' as any)
    }
    return {}
  },

  async SetDarkMode({ mode }) {
    app.setTheme(mode as any)
    return {}
  },

  async SetWindowControlsColor() {
    // Stub: no direct API equivalent in MoBrowser
    return {}
  },

  async Reload() {
    win.browser.reload()
    return {}
  },

  async OpenDevTools() {
    win.browser.openDevTools()
    return {}
  },

  async ToggleFullscreen() {
    if (win.isFullScreen) {
      win.exitFullScreen()
    } else {
      win.enterFullScreen()
    }
    return {}
  },

  OnShown(_req, ctx) { return onShown.subscribe(ctx) },
  OnMoved(_req, ctx) { return onMoved.subscribe(ctx) },
  OnFocused(_req, ctx) { return onFocused.subscribe(ctx) },
  OnEnterFullScreen(_req, ctx) { return onEnterFullScreen.subscribe(ctx) },
  OnLeaveFullScreen(_req, ctx) { return onLeaveFullScreen.subscribe(ctx) },
  OnMaximized(_req, ctx) { return onMaximized.subscribe(ctx) },
  OnUnmaximized(_req, ctx) { return onUnmaximized.subscribe(ctx) },
  OnCloseRequest(_req, ctx) { return onCloseRequest.subscribe(ctx) },
  OnBecameMainWindow(_req, ctx) { return onBecameMainWindow.subscribe(ctx) },
})

// ---------------------------------------------------------------------------
// DialogService
// ---------------------------------------------------------------------------

ipc.registerService(DialogServiceDescriptor, {
  async ShowOpenDialog({ title, defaultPath, properties, filters }) {
    const allowMultiple = properties?.includes('multiSelections') ?? false
    const allowDirs = properties?.includes('openDirectory') ?? false
    const result = await app.showOpenDialog({
      parentWindow: win,
      title,
      defaultPath: defaultPath || undefined,
      selectionPolicy: allowDirs ? 'directories' : 'files',
      filters: filters?.map(f => ({ name: f.name, extensions: f.extensions })),
      features: { allowMultiple },
    })
    return {
      filePaths: result.canceled ? [] : result.paths,
      canceled: result.canceled,
    }
  },

  async ShowSaveDialog({ title, defaultPath, filters }) {
    const result = await app.showSaveDialog({
      parentWindow: win,
      title,
      defaultPath: defaultPath || undefined,
      filters: filters?.map(f => ({ name: f.name, extensions: f.extensions })),
    })
    return {
      filePath: result.canceled ? '' : result.path,
      canceled: result.canceled,
    }
  },

  async ShowMessageBox({ title, message, buttons }) {
    const mappedButtons = (buttons ?? []).map(b => ({
      label: b.label,
      type: (b.isDefault ? 'primary' : b.isCancel ? 'cancel' : 'secondary') as any,
    }))
    if (mappedButtons.length === 0) {
      mappedButtons.push({ label: 'OK', type: 'primary' as any })
    }
    const result = await app.showMessageDialog({
      parentWindow: win,
      title,
      message,
      buttons: mappedButtons,
    })
    const responseIndex = (buttons ?? []).findIndex(b => b.label === result.button.label)
    return {
      response: responseIndex >= 0 ? responseIndex : 0,
      checkboxChecked: false,
    }
  },
})

// ---------------------------------------------------------------------------
// ScreenService
// ---------------------------------------------------------------------------

const onDisplaysChanged = new PubSub<DisplayList>()
const onDisplayMetricsChanged = new PubSub<DisplayInfo>()

function toDisplayInfo(d: any): DisplayInfo {
  return {
    id: d.id ?? 0,
    bounds: d.bounds
      ? { x: d.bounds.x ?? 0, y: d.bounds.y ?? 0, width: d.bounds.width ?? 0, height: d.bounds.height ?? 0 }
      : undefined,
    workArea: d.workArea
      ? { x: d.workArea.x ?? 0, y: d.workArea.y ?? 0, width: d.workArea.width ?? 0, height: d.workArea.height ?? 0 }
      : undefined,
    scaleFactor: d.scaleFactor ?? 1,
    isPrimary: d.isPrimary ?? false,
  }
}

displays.on('displayConnected', () => {
  onDisplaysChanged.publish({ displays: displays.all.map(toDisplayInfo) })
})
displays.on('displayDisconnected', () => {
  onDisplaysChanged.publish({ displays: displays.all.map(toDisplayInfo) })
})
displays.on('displayChanged', (d: any) => {
  onDisplayMetricsChanged.publish(toDisplayInfo(d))
})

ipc.registerService(ScreenServiceDescriptor, {
  async GetAllDisplays() {
    return { displays: displays.all.map(toDisplayInfo) }
  },

  async GetPrimaryDisplay() {
    const primary = displays.primary
    if (!primary) return { id: 0, bounds: undefined, workArea: undefined, scaleFactor: 1, isPrimary: true }
    return toDisplayInfo(primary)
  },

  async GetDisplayNearestPoint() {
    // Stub: MoBrowser has no getNearestDisplay API — fall back to primary
    const primary = displays.primary
    if (!primary) return { id: 0, bounds: undefined, workArea: undefined, scaleFactor: 1, isPrimary: true }
    return toDisplayInfo(primary)
  },

  async GetCursorPoint() {
    // Stub: cursor position requires native module
    return { x: 0, y: 0 }
  },

  OnDisplaysChanged(_req, ctx) { return onDisplaysChanged.subscribe(ctx) },
  OnDisplayMetricsChanged(_req, ctx) { return onDisplayMetricsChanged.subscribe(ctx) },
})

// ---------------------------------------------------------------------------
// MenuService — stub
// ---------------------------------------------------------------------------

ipc.registerService(MenuServiceDescriptor, {
  async *ShowContextMenu(_req, ctx: StreamContext) {
    // Stub: context menu integration with BrowserWindow/View TBD
    const queue = new AsyncQueue<MenuClickEvent>()
    ctx.signal.addEventListener('abort', () => queue.close())
    yield* queue
  },

  async SetDockMenu() {
    // Stub: dock menu TBD
    return {}
  },
})

// ---------------------------------------------------------------------------
// PowerService — stub
// ---------------------------------------------------------------------------

let nextBlockerId = 1

ipc.registerService(PowerServiceDescriptor, {
  async StartBlocker() {
    // Stub: power save blocker TBD
    return { id: nextBlockerId++ }
  },

  async StopBlocker() {
    // Stub: power save blocker TBD
    return {}
  },
})

// ---------------------------------------------------------------------------
// ThemeService
// ---------------------------------------------------------------------------

const onNativeThemeUpdated = new PubSub<NativeTheme>()

function getCurrentTheme(): NativeTheme {
  return {
    shouldUseDarkColors: app.theme === 'dark',
    isHighContrast: false,
    isInvertedColorScheme: false,
  }
}

ipc.registerService(ThemeServiceDescriptor, {
  async GetNativeTheme() {
    return getCurrentTheme()
  },

  OnNativeThemeUpdated(_req, ctx) {
    return onNativeThemeUpdated.subscribe(ctx)
  },
})

// ---------------------------------------------------------------------------
// UpdaterService — stub
// ---------------------------------------------------------------------------

const onUpdateAvailable = new PubSub<UpdateInfo>()
const onUpdateNotAvailable = new PubSub<Empty>()
const onUpdateDownloaded = new PubSub<UpdateInfo>()
const onUpdateError = new PubSub<UpdateError>()

ipc.registerService(UpdaterServiceDescriptor, {
  async CheckForUpdates() {
    // Stub: invoke app.checkForUpdate with a configured update URL when available
    return {}
  },

  async QuitAndInstall() {
    app.quit()
    return {}
  },

  OnUpdateAvailable(_req, ctx) { return onUpdateAvailable.subscribe(ctx) },
  OnUpdateNotAvailable(_req, ctx) { return onUpdateNotAvailable.subscribe(ctx) },
  OnUpdateDownloaded(_req, ctx) { return onUpdateDownloaded.subscribe(ctx) },
  OnUpdateError(_req, ctx) { return onUpdateError.subscribe(ctx) },
})

// ---------------------------------------------------------------------------
// ShellService — stub
// ---------------------------------------------------------------------------

ipc.registerService(ShellServiceDescriptor, {
  async GetExePath() {
    return { value: '' }
  },

  async IsInstalled() {
    return { value: false }
  },

  async Install() {
    return {}
  },

  async Remove() {
    return {}
  },
})

// ---------------------------------------------------------------------------
// SshService
// ---------------------------------------------------------------------------

ipc.registerService(SshServiceDescriptor, sshService)

// ---------------------------------------------------------------------------
// TelnetService
// ---------------------------------------------------------------------------

ipc.registerService(TelnetServiceDescriptor, telnetService)

// ---------------------------------------------------------------------------
// KeychainService
// ---------------------------------------------------------------------------

ipc.registerService(KeychainServiceDescriptor, keychainService)

// ---------------------------------------------------------------------------
// Application lifecycle
// ---------------------------------------------------------------------------

app.on('allWindowsClosed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activated', () => {
  if (app.windows.length === 0) {
    const newWin = new BrowserWindow()
    newWin.browser.loadUrl(app.url)
    newWin.setSize({ width: 1200, height: 800 })
    newWin.centerWindow()
    newWin.show()
  }
})
