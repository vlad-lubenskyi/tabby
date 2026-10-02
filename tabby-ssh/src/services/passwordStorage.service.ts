import { Injectable } from '@angular/core'
import { VaultService } from 'tabby-core'
import { SSHProfile } from '../api'

export const VAULT_SECRET_TYPE_PASSWORD = 'ssh:password'
export const VAULT_SECRET_TYPE_PASSPHRASE = 'ssh:key-passphrase'

@Injectable({ providedIn: 'root' })
export class PasswordStorageService {
    constructor (private vault: VaultService) { }

    async savePassword (profile: SSHProfile, password: string, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSWORD, key, value: password })
        } else {
            if (!account) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            return (window as any).tabbyAPI.ipc.invoke('keytar:set-password', key, account, password)
        }
    }

    async deletePassword (profile: SSHProfile, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            this.vault.removeSecret(VAULT_SECRET_TYPE_PASSWORD, key)
        } else {
            if (!account) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            await (window as any).tabbyAPI.ipc.invoke('keytar:delete-password', key, account)
        }
    }

    async loadPassword (profile: SSHProfile, username?: string): Promise<string|null> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSWORD, key))?.value ?? null
        } else {
            if (!account) {
                return null
            }
            const key = this.getKeytarKeyForConnection(profile)
            try {
                return await (window as any).tabbyAPI.ipc.invoke('keytar:get-password', key, account)
            } catch (e) {
                console.warn(`Failed to load stored password for ${account}@${profile.options.host}:${profile.options.port ?? 22}`, e)
                return null
            }
        }
    }

    async savePrivateKeyPassword (id: string, password: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSPHRASE, key, value: password })
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return (window as any).tabbyAPI.ipc.invoke('keytar:set-password', key, 'user', password)
        }
    }

    async deletePrivateKeyPassword (id: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            this.vault.removeSecret(VAULT_SECRET_TYPE_PASSPHRASE, key)
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            await (window as any).tabbyAPI.ipc.invoke('keytar:delete-password', key, 'user')
        }
    }

    async loadPrivateKeyPassword (id: string): Promise<string|null> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSPHRASE, key))?.value ?? null
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return (window as any).tabbyAPI.ipc.invoke('keytar:get-password', key, 'user')
        }
    }

    private getKeytarKeyForConnection (profile: SSHProfile): string {
        let key = `ssh@${profile.options.host}`
        if (profile.options.port) {
            key = `ssh@${profile.options.host}:${profile.options.port}`
        }
        return key
    }

    private getKeytarKeyForPrivateKey (id: string): string {
        return `ssh-private-key:${id}`
    }

    private getVaultKeyForConnection (profile: SSHProfile, username?: string) {
        return {
            user: username ?? profile.options.user,
            host: profile.options.host,
            port: profile.options.port,
        }
    }

    private getVaultKeyForPrivateKey (id: string) {
        return { hash: id }
    }
}
