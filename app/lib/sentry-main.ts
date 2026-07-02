// Main-process Sentry initialisation.
// Imported by lib/index.ts. Must NOT reference ipcRenderer, contextBridge, or @electron/remote.
export {}

const SENTRY_MAIN_DSN = 'https://4717a0a7ee0b4429bd3a0f06c3d7eec3@sentry.io/181876'

if (!process.env.TABBY_DEV) {
    try {
        const { init } = require('@sentry/electron/dist/main')
        init({ dsn: SENTRY_MAIN_DSN })
    } catch {
        // @sentry/electron may not be available in all build configs
    }
}
