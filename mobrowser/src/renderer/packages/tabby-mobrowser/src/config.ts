// Copied from: tabby-electron/src/config.ts
import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class MoBrowserConfigProvider extends ConfigProvider {
    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'toggle-window': ['Ctrl-Space'],
                'new-window': ['⌘-N'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'toggle-window': ['Ctrl-Space'],
                'new-window': ['Ctrl-Shift-N'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'toggle-window': ['Ctrl-Space'],
                'new-window': ['Ctrl-Shift-N'],
            },
        },
    }

    defaults = {}
}
