// Preload script — runs in Node context before the renderer bundle.
// Loaded by BrowserWindow.webPreferences.preload (dist/sentry.js).
// Must NOT be imported by the main process.
// Security contract: no @electron/remote, no raw require exposure, sandbox: true compatible.
export {}

const { contextBridge, ipcRenderer, shell, clipboard, webUtils } = require('electron')

const { init } = require('@sentry/electron/dist/renderer')
const SENTRY_DSN = 'https://4717a0a7ee0b4429bd3a0f06c3d7eec3@sentry.io/181876'
if (!process.env.TABBY_DEV) {
    init({
        dsn: SENTRY_DSN,
        integrations (integrations) {
            return integrations.filter(integration => integration.name !== 'Breadcrumbs')
        },
    })
}

// Fetch static app metadata from the main process synchronously.
// ipcRenderer.sendSync is the only safe alternative to @electron/remote in a sandboxed preload.
const appInfo = ipcRenderer.sendSync('app:get-paths') as {
    appPath: string
    appVersion: string
    userDataPath: string
    exePath: string
}

// Expose a minimal, explicit surface to the renderer via contextBridge.
// The renderer has NO access to Node.js, Electron internals, or require beyond what is listed here.
contextBridge.exposeInMainWorld('tabbyAPI', {
    // Static app metadata from main process
    appPath: appInfo.appPath,
    appVersion: appInfo.appVersion,
    userDataPath: appInfo.userDataPath,
    exePath: appInfo.exePath,
    // Runtime process values — read from the preload's Node.js context so the renderer
    // does NOT need to access `process` directly (it's unavailable in isolated context).
    platform: process.platform,
    osRelease: (process as any).getSystemVersion?.() ?? '',
    arch: process.arch,
    resourcesPath: (process as any).resourcesPath ?? '',
    devMode: !!process.env.TABBY_DEV,
    forceAngularProd: !!process.env.TABBY_FORCE_ANGULAR_PROD,
    tabbyPlugins: process.env.TABBY_PLUGINS ?? '',
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE ?? null,
    env: {
        HOME:              process.env.HOME ?? null,
        LOGNAME:           process.env.LOGNAME ?? null,
        USERNAME:          process.env.USERNAME ?? null,
        USERPROFILE:       process.env.USERPROFILE ?? null,
        SystemRoot:        process.env.SystemRoot ?? null,
        windir:            process.env.windir ?? null,
        ProgramFiles:      process.env.ProgramFiles ?? null,
        'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] ?? null,
        CMDER_ROOT:        process.env.CMDER_ROOT ?? null,
        PATHEXT:           process.env.PATHEXT ?? null,
    },
    ipc: {
        send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
        invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
        on: (channel: string, listener: (...args: any[]) => void) => {
            const wrapped = (_event: any, ...a: any[]) => listener(...a)
            ipcRenderer.on(channel, wrapped)
            return () => ipcRenderer.off(channel, wrapped)
        },
        once: (channel: string, listener: (...args: any[]) => void) => {
            ipcRenderer.once(channel, (_event: any, ...a: any[]) => listener(...a))
        },
        off: (channel: string, listener: (...args: any[]) => void) => ipcRenderer.off(channel, listener),
    },
    shell: {
        openExternal: (url: string) => shell.openExternal(url),
        showItemInFolder: (p: string) => shell.showItemInFolder(p),
        openPath: (p: string) => shell.openPath(p),
    },
    clipboard: {
        readText: () => clipboard.readText(),
        write: (content: Electron.Data) => clipboard.write(content),
    },
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
})
