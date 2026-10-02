// Derived from: tabby-electron/src/services/fileProvider.service.ts
import { Injectable } from '@angular/core'
import { FileProvider } from 'tabby-core'
import { ipc } from '@gen/ipc'

@Injectable()
export class MoBrowserFileProvider extends FileProvider {
    name = 'Filesystem'

    async selectAndStoreFile(description: string): Promise<string> {
        const result = await ipc.dialog.ShowOpenDialog({
            title: '',
            buttonLabel: `Select ${description}`,
            properties: ['openFile', 'treatPackageAsDirectory'],
            filters: [],
            defaultPath: '',
        })
        if (result.canceled || !result.filePaths.length) {
            throw new Error('canceled')
        }

        return `file://${result.filePaths[0]}`
    }

    async retrieveFile(key: string): Promise<Uint8Array> {
        if (key.startsWith('file://')) {
            key = key.substring('file://'.length)
        } else if (key.includes('://')) {
            throw new Error('Incorrect type')
        }
        const result = await ipc.fs.ReadFile({ path: key })
        return result.data
    }
}
