// Copied from: tabby-electron/src/hotkeys.ts
import { Injectable } from '@angular/core'
import { type HotkeyDescription, HotkeyProvider, TranslateService } from 'tabby-core'

/** @hidden */
@Injectable()
export class MoBrowserHotkeyProvider extends HotkeyProvider {
    hotkeys: HotkeyDescription[] = [
        {
            id: 'new-window',
            name: this.translate.instant('New window'),
        },
        {
            id: 'toggle-window',
            name: this.translate.instant('Toggle terminal window'),
        },
    ]

    constructor(private translate: TranslateService) { super() }

    async provide(): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}
