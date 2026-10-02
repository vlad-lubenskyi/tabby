import type { PartialProfile } from 'tabby-core'
import type { SSHProfile } from './interfaces'

export abstract class SSHProfileImporter {
    abstract getProfiles (): Promise<PartialProfile<SSHProfile>[]>
}

export abstract class AutoPrivateKeyLocator {
    abstract getKeys (): Promise<[string, Buffer][]>
}
