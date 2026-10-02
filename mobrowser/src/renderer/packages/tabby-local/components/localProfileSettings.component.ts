/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Inject, Optional } from '@angular/core'
import { UACService } from '../api'
import type { LocalProfile } from '../api'
import { PlatformService } from 'tabby-core'
import type { FullyDefined, ProfileSettingsComponent } from 'tabby-core'
import { LocalProfilesService } from '../profiles'


/** @hidden */
@Component({
    templateUrl: './localProfileSettings.component.pug',
})
export class LocalProfileSettingsComponent implements ProfileSettingsComponent<LocalProfile, LocalProfilesService> {
    profile: FullyDefined<LocalProfile>

    constructor (
        @Optional() @Inject(UACService) public uac: UACService|undefined,
        private platform: PlatformService,
    ) { }

    async pickWorkingDirectory (): Promise<void> {
        const cwd = await this.platform.pickDirectory()
        if (!cwd) {
            return
        }
        this.profile.options.cwd = cwd
    }
}
