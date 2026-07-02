import deepEqual from 'deep-equal'
import { Subject, distinctUntilChanged, map } from 'rxjs'
import { Injectable, NgZone } from '@angular/core'
import { AppService, HostAppService, Platform } from 'tabby-core'

const ipc = () => (window as any).tabbyAPI?.ipc

/** @hidden */
@Injectable({ providedIn: 'root' })
export class TouchbarService {
    private touchbarState$ = new Subject<any>()

    private constructor (
        private app: AppService,
        private hostApp: HostAppService,
        private zone: NgZone,
    ) {
        if (this.hostApp.platform !== Platform.macOS) {
            return
        }
        app.tabsChanged$.subscribe(() => this.update())
        app.activeTabChange$.subscribe(() => this.update())

        app.tabOpened$.subscribe(tab => {
            tab.titleChange$.subscribe(() => this.update())
            tab.activity$.pipe(
                map(x => !x || tab === app.activeTab),
                distinctUntilChanged(),
            ).subscribe(() => this.update())
        })

        ipc()?.on('touchbar-selection', (index: number) => this.zone.run(() => {
            this.app.selectTab(this.app.tabs[index])
        }))

        this.touchbarState$.pipe(distinctUntilChanged(deepEqual)).subscribe(state => {
            ipc()?.send('window-set-touch-bar', ...state)
        })
    }

    update (): void {
        if (this.hostApp.platform !== Platform.macOS) {
            return
        }

        const tabSegments = this.app.tabs.map(tab => ({
            label: this.shortenTitle(tab.title),
            hasActivity: this.app.activeTab !== tab && tab.hasActivity,
        }))

        this.touchbarState$.next([tabSegments, this.app.activeTab ? this.app.tabs.indexOf(this.app.activeTab) : undefined])
    }

    private shortenTitle (title: string): string {
        if (title.length > 15) {
            title = title.substring(0, 15) + '...'
        }
        return title
    }
}
