/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { ApplicationRef, NgModule } from '@angular/core'
import { BrowserModule } from '@angular/platform-browser'
import { ToastrModule } from 'ngx-toastr'

export function getRootModule (plugins: any[], bootstrapComponent: any, providers: any[] = []) {
    const imports = [
        BrowserModule,
        ...plugins,
        ToastrModule.forRoot({
            positionClass: 'toast-bottom-center',
            toastClass: 'toast',
            preventDuplicates: true,
            extendedTimeOut: 1000,
        }),
    ]

    @NgModule({
        imports,
        providers,
    }) class RootModule {
        ngDoBootstrap (appRef: ApplicationRef) {
            (window as any)['requestAnimationFrame'] = window[window['Zone'].__symbol__('requestAnimationFrame')]

            appRef.bootstrap(bootstrapComponent)
        }
    }

    return RootModule
}
