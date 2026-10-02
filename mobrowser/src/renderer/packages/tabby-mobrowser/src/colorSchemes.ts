// Derived from: tabby-electron/src/colorSchemes.ts
import { Injectable } from '@angular/core'
import { TerminalColorSchemeProvider, type TerminalColorScheme } from 'tabby-terminal'
import { ipc } from '@gen/ipc'

/** @hidden */
@Injectable()
export class HyperColorSchemes extends TerminalColorSchemeProvider {
    async getSchemes(): Promise<TerminalColorScheme[]> {
        const result = await ipc.platform.GetColorSchemes({})
        return result.schemes.map(s => {
            try {
                return JSON.parse(new TextDecoder().decode(s.data)) as TerminalColorScheme
            } catch {
                return null
            }
        }).filter(Boolean) as TerminalColorScheme[]
    }
}
