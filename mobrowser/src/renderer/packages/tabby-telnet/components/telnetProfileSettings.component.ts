/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component } from '@angular/core'

import type { FullyDefined, ProfileSettingsComponent } from 'tabby-core'
import type { TelnetProfile } from '../session'
import { TelnetProfilesService } from '../profiles'

/** @hidden */
@Component({
    templateUrl: './telnetProfileSettings.component.pug',
})
export class TelnetProfileSettingsComponent implements ProfileSettingsComponent<TelnetProfile, TelnetProfilesService> {
    profile: FullyDefined<TelnetProfile>
}
