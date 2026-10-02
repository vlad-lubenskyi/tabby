/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector } from '@angular/core'
import { Platform, SelectorService } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { SerialSession, BAUD_RATES } from '../api'
import type { SerialProfile } from '../api'
import serialTabTemplate from './serialTab.component.pug'
import serialTabStyles from './serialTab.component.scss?inline'

/** @hidden */
@Component({
    selector: 'serial-tab',
    template: `${BaseTerminalTabComponent.template} ${serialTabTemplate}`,
    styles: [serialTabStyles, ...BaseTerminalTabComponent.styles],
    animations: BaseTerminalTabComponent.animations,
})
export class SerialTabComponent extends ConnectableTerminalTabComponent<SerialProfile> {
    session: SerialSession|null = null
    Platform = Platform

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
        private selector: SelectorService,
    ) {
        super(injector)
        this.enableToolbar = true
    }

    ngOnInit () {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1b[H' )
                    break
                case 'end':
                    this.sendInput('\x1b[F' )
                    break
                case 'restart-serial-session':
                    this.reconnect()
                    break
            }
        })

        super.ngOnInit()

        setImmediate(() => {
            this.setTitle(this.profile.name)
        })
    }

    async initializeSession () {
        super.initializeSession()

        const session = new SerialSession(this.injector, this.profile)
        this.setSession(session)

        this.startSpinner(this.translate.instant(_('Connecting')))

        try {
            await this.session!.start()
            this.stopSpinner()
            session.emitServiceMessage(this.translate.instant(_('Port opened')))
        } catch (e: unknown) {
            this.stopSpinner()
            this.write(colors.black.bgRed(' X ') + ' ' + colors.red(String(e)) + '\r\n')
            return
        }
        this.session!.resize(this.size.columns, this.size.rows)
    }

    protected attachSessionHandlers () {
        this.attachSessionHandler(this.session!.serviceMessage$, msg => {
            this.write(`\r\n${colors.black.bgWhite(' Serial ')} ${msg}\r\n`)
            this.session?.resize(this.size.columns, this.size.rows)
        })
        super.attachSessionHandlers()
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SERIAL ') + ` session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    async changeBaudRate (): Promise<void> {
        const rate = await this.selector.show(
            this.translate.instant(_('Baud rate')),
            BAUD_RATES.map(x => ({
                name: x.toString(), result: x, weight: x,
            })),
        )
        this.profile.options.baudrate = rate
        await this.reconnect()
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.endsWith('close\r') ||
        this.recentInputs.endsWith('quit\r')
    }
}
