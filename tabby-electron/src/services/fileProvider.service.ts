import { Injectable } from '@angular/core'
import { FileProvider } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

@Injectable()
export class ElectronFileProvider extends FileProvider {
    name = 'Filesystem'

    constructor (
        private electron: ElectronService,
    ) {
        super()
    }

    async selectAndStoreFile (description: string): Promise<string> {
        const result = await this.electron.showOpenDialog(
            {
                buttonLabel: `Select ${description}`,
                properties: ['openFile', 'treatPackageAsDirectory'],
            },
        )
        if (result.canceled || !result.filePaths.length) {
            throw new Error('canceled')
        }

        return `file://${result.filePaths[0]}`
    }

    async retrieveFile (key: string): Promise<Uint8Array> {
        if (key.startsWith('file://')) {
            key = key.substring('file://'.length)
        } else if (key.includes('://')) {
            throw new Error('Incorrect type')
        }
        return this.electron.ipc.invoke('bridge:file:read', key)
    }
}
