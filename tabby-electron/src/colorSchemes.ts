import { Injectable } from '@angular/core'
import { TerminalColorSchemeProvider, TerminalColorScheme } from 'tabby-terminal'

/** @hidden */
@Injectable()
export class HyperColorSchemes extends TerminalColorSchemeProvider {
    private get ipc () { return (window as any).tabbyAPI?.ipc }

    async getSchemes (): Promise<TerminalColorScheme[]> {
        return this.ipc.invoke('bridge:hyper:get-color-schemes')
    }
}
