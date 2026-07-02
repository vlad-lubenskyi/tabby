import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AsyncSubject, Subject, Observable } from 'rxjs'
import { wrapPromise, serializeFunction } from '../utils'
import { UnlockVaultModalComponent } from '../components/unlockVaultModal.component'
import { NotificationsService } from './notifications.service'
import { SelectorService } from './selector.service'
import { FileProvider } from '../api/fileProvider'
import { PlatformService } from '../api/platform'

const PBKDF_ITERATIONS = 100000
const PBKDF_SALT_LENGTH = 64 / 8
const CRYPT_KEY_LENGTH = 256 / 8
const CRYPT_IV_LENGTH = 128 / 8

export interface StoredVault {
    version: number
    contents: string
    keySalt: string
    iv: string
}

export interface VaultSecret {
    type: string
    key: VaultSecretKey
    value: string
}

export interface VaultFileSecret extends VaultSecret {
    key: {
        id: string
        description: string
    }
}

export interface Vault {
    config: any
    secrets: VaultSecret[]
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface VaultSecretKey { }

function migrateVaultContent (content: any): Vault {
    return {
        config: content.config,
        secrets: content.secrets ?? [],
    }
}

function hexToBytes (hex: string): Uint8Array {
    const arr = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
        arr[i / 2] = parseInt(hex.slice(i, i + 2), 16)
    }
    return arr
}

function bytesToHex (bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function deriveVaultKey (passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder()
    const baseKey = await globalThis.crypto.subtle.importKey(
        'raw',
        enc.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    )
    return globalThis.crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations: PBKDF_ITERATIONS,
            hash: 'SHA-512',
        },
        baseKey,
        { name: 'AES-CBC', length: CRYPT_KEY_LENGTH * 8 },
        false,
        ['encrypt', 'decrypt'],
    )
}

async function encryptVault (content: Vault, passphrase: string): Promise<StoredVault> {
    const keySalt = globalThis.crypto.getRandomValues(new Uint8Array(PBKDF_SALT_LENGTH))
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(CRYPT_IV_LENGTH))
    const key = await deriveVaultKey(passphrase, keySalt)

    const plaintext = new TextEncoder().encode(JSON.stringify(content))
    const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
        { name: 'AES-CBC', iv },
        key,
        plaintext,
    ))

    return {
        version: 1,
        contents: btoa(String.fromCharCode(...encrypted)),
        keySalt: bytesToHex(keySalt),
        iv: bytesToHex(iv),
    }
}

async function decryptVault (vault: StoredVault, passphrase: string): Promise<Vault> {
    if (vault.version !== 1) {
        throw new Error(`Unsupported vault format version ${vault.version}`)
    }
    const keySalt = hexToBytes(vault.keySalt)
    const iv = hexToBytes(vault.iv)
    const encrypted = Uint8Array.from(atob(vault.contents), c => c.charCodeAt(0))

    const key = await deriveVaultKey(passphrase, keySalt)
    const decrypted = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-CBC', iv },
        key,
        encrypted,
    )
    return migrateVaultContent(JSON.parse(new TextDecoder().decode(decrypted)))
}

export const VAULT_SECRET_TYPE_FILE = 'file'

// Don't make it accessible through VaultService fields
let _rememberedPassphrase: string|null = null

@Injectable({ providedIn: 'root' })
export class VaultService {
    /** Fires once when the config is loaded */
    get ready$ (): Observable<boolean> { return this.ready }

    get contentChanged$ (): Observable<void> { return this.contentChanged }

    store: StoredVault|null = null
    private ready = new AsyncSubject<boolean>()
    private contentChanged = new Subject<void>()

    /** @hidden */
    private constructor (
        private zone: NgZone,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
    ) {
        this.getPassphrase = serializeFunction(this.getPassphrase.bind(this))
    }

    async setEnabled (enabled: boolean, passphrase?: string): Promise<void> {
        if (enabled) {
            if (!this.store) {
                await this.save(migrateVaultContent({}), passphrase)
            }
        } else {
            this.store = null
            this.contentChanged.next()
        }
    }

    isOpen (): boolean {
        return !!_rememberedPassphrase
    }

    forgetPassphrase (): void {
        _rememberedPassphrase = null
    }

    async decrypt (storage: StoredVault, passphrase?: string): Promise<Vault> {
        if (!passphrase) {
            passphrase = await this.getPassphrase()
        }
        try {
            return await wrapPromise(this.zone, decryptVault(storage, passphrase))
        } catch (e) {
            this.forgetPassphrase()
            if (e instanceof DOMException || e.toString().includes('BAD_DECRYPT')) {
                this.notifications.error('Incorrect passphrase')
            }
            throw e
        }
    }

    async load (passphrase?: string): Promise<Vault|null> {
        if (!this.store) {
            return null
        }
        return this.decrypt(this.store, passphrase)
    }

    async encrypt (vault: Vault, passphrase?: string): Promise<StoredVault|null> {
        if (!passphrase) {
            passphrase = await this.getPassphrase()
        }
        if (_rememberedPassphrase) {
            _rememberedPassphrase = passphrase
        }
        return wrapPromise(this.zone, encryptVault(vault, passphrase))
    }

    async save (vault: Vault, passphrase?: string): Promise<void> {
        await this.ready$.toPromise()
        this.store = await this.encrypt(vault, passphrase)
        this.contentChanged.next()
    }

    async getPassphrase (): Promise<string> {
        if (!_rememberedPassphrase) {
            const modal = this.ngbModal.open(UnlockVaultModalComponent)
            const { passphrase, rememberFor } = await modal.result
            setTimeout(() => {
                _rememberedPassphrase = null
                // avoid multiple consequent prompts
            }, Math.max(1000, rememberFor * 60000))
            _rememberedPassphrase = passphrase
        }

        return _rememberedPassphrase!
    }

    async getSecret (type: string, key: VaultSecretKey): Promise<VaultSecret|null> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return null
        }
        let vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        if (!vaultSecret) {
            // search for secret without host in vault (like a default user/password used in multiple servers)
            key['host'] = null
            vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        }
        return vaultSecret ?? null
    }

    async addSecret (secret: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== secret.type || !this.keyMatches(secret.key, s))
        vault.secrets.push(secret)
        await this.save(vault)
    }

    async updateSecret (secret: VaultSecret, update: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        const target = vault.secrets.find(s => s.type === secret.type && this.keyMatches(secret.key, s))
        if (!target) {
            return
        }
        Object.assign(target, update)
        await this.save(vault)
    }

    async removeSecret (type: string, key: VaultSecretKey): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== type || !this.keyMatches(key, s))
        await this.save(vault)
    }

    private keyMatches (key: VaultSecretKey, secret: VaultSecret): boolean {
        return Object.keys(key).every(k => secret.key[k] === key[k])
    }

    setStore (store: StoredVault): void {
        this.store = store
        this.ready.next(true)
        this.ready.complete()
    }

    isEnabled (): boolean {
        return !!this.store
    }
}


@Injectable()
export class VaultFileProvider extends FileProvider {
    name = 'Vault'
    prefix = 'vault://'

    constructor (
        private vault: VaultService,
        private platform: PlatformService,
        private selector: SelectorService,
    ) {
        super()
    }

    async isAvailable (): Promise<boolean> {
        return this.vault.isEnabled()
    }

    async selectAndStoreFile (description: string): Promise<string> {
        const vault = await this.vault.load()
        if (!vault) {
            throw new Error('Vault is locked')
        }
        const files = vault.secrets.filter(x => x.type === VAULT_SECRET_TYPE_FILE) as VaultFileSecret[]
        if (files.length) {
            const result = await this.selector.show<VaultFileSecret|null>('Select file', [
                {
                    name: 'Add a new file',
                    icon: 'fas fa-plus',
                    result: null,
                },
                ...files.map(f => ({
                    name: f.key.description,
                    icon: 'fas fa-file',
                    result: f,
                })),
            ]).catch(() => null)
            if (result) {
                return `${this.prefix}${result.key.id}`
            }
        }
        return this.addNewFile(description)
    }

    async addNewFile (description: string): Promise<string> {
        const transfers = await this.platform.startUpload()
        if (!transfers.length) {
            throw new Error('Nothing selected')
        }
        const transfer = transfers[0]
        const idBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
        const id = bytesToHex(idBytes)
        await this.vault.addSecret({
            type: VAULT_SECRET_TYPE_FILE,
            key: {
                id,
                description: `${description} (${transfer.getName()})`,
            },
            value: btoa(String.fromCharCode(...new Uint8Array(await transfer.readAll()))),
        })
        return `${this.prefix}${id}`
    }

    async retrieveFile (key: string): Promise<Uint8Array> {
        if (!key.startsWith(this.prefix)) {
            throw new Error('Incorrect type')
        }
        const secret = await this.vault.getSecret(VAULT_SECRET_TYPE_FILE, { id: key.substring(this.prefix.length) })
        if (!secret) {
            throw new Error('Not found')
        }
        return Uint8Array.from(atob(secret.value), c => c.charCodeAt(0))
    }
}
