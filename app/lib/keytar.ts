import { ipcMain } from 'electron'
import * as keytar from 'keytar'

export function initKeytar (): void {
    ipcMain.handle('keytar:get-password', (_e, service: string, account: string) =>
        keytar.getPassword(service, account))
    ipcMain.handle('keytar:set-password', (_e, service: string, account: string, password: string) =>
        keytar.setPassword(service, account, password))
    ipcMain.handle('keytar:delete-password', (_e, service: string, account: string) =>
        keytar.deletePassword(service, account))
}
