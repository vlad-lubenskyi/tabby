// Derived from: tabby-electron/src/terminalContextMenu.ts
import { Injectable } from '@angular/core'
import { NotificationsService, TranslateService } from 'tabby-core'
import type { MenuItemOptions } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalContextMenuItemProvider } from 'tabby-terminal'
import { ipc } from '@gen/ipc'

/** @hidden */
@Injectable()
export class ExportTerminalContextMenu extends TerminalContextMenuItemProvider {
    weight = 0

    constructor(
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems(tab: BaseTerminalTabComponent<any>): Promise<MenuItemOptions[]> {
        return [
            {
                label: this.translate.instant('Export to file'),
                click: async () => {
                    const frontend = tab.frontend
                    if (!frontend) {
                        return
                    }
                    const result = await ipc.dialog.ShowSaveDialog({
                        title: '',
                        defaultPath: 'terminal.txt',
                        filters: [],
                    })
                    if (!result.filePath) {
                        return
                    }
                    frontend.selectAll()
                    const content = frontend.getSelection()
                    frontend.clearSelection()
                    await ipc.fs.WriteFile({
                        path: result.filePath,
                        data: new TextEncoder().encode(content),
                    })
                    this.notifications.info(this.translate.instant('Saved to {path}', { path: result.filePath }))
                },
            },
        ]
    }
}
