/* eslint-disable @typescript-eslint/no-unused-vars */
import { Subject, Observable } from 'rxjs'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'

// SFTP file type constants (from russh SFTPFileType enum)
const SFTP_FILE_TYPE_DIRECTORY = 2
const SFTP_FILE_TYPE_SYMLINK = 3

// SFTP open flags
export const SFTP_OPEN_READ = 1
export const SFTP_OPEN_WRITE = 2
export const SFTP_OPEN_CREATE = 8

function posixJoin (p: string, name: string): string {
    return p.endsWith('/') ? p + name : p + '/' + name
}

function posixBasename (p: string): string {
    return p.split('/').pop() || p
}

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private sessionId: string,
        private handleId: string,
        private ipc: any,
    ) { }

    async read (): Promise<Uint8Array> {
        const data: Uint8Array = await this.ipc.invoke('ssh:session:sftp-read', this.sessionId, this.handleId, 262144)
        return data ?? new Uint8Array(0)
    }

    async write (chunk: Uint8Array): Promise<void> {
        await this.ipc.invoke('ssh:session:sftp-write', this.sessionId, this.handleId, chunk)
    }

    async close (): Promise<void> {
        await this.ipc.invoke('ssh:session:sftp-close', this.sessionId, this.handleId)
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private logger: Logger

    constructor (
        private sessionId: string,
        private ipc: any,
        injector: Injector,
        sessionClose$: Observable<void>,
    ) {
        this.logger = injector.get(LogService).create('sftp')
        sessionClose$.subscribe(() => {
            this.closed.next()
            this.closed.complete()
        })
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const entries: Array<{ name: string; metadata: { type: number; permissions: number; size: number; mtime: number } }> =
            await this.ipc.invoke('ssh:session:sftp-readdir', this.sessionId, p)
        return entries.map(entry => this._makeFile(posixJoin(p, entry.name), entry))
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return this.ipc.invoke('ssh:session:sftp-readlink', this.sessionId, p)
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats: { type: number; permissions: number; size: number; mtime: number } =
            await this.ipc.invoke('ssh:session:sftp-stat', this.sessionId, p)
        return {
            name: posixBasename(p),
            fullPath: p,
            isDirectory: stats.type === SFTP_FILE_TYPE_DIRECTORY,
            isSymlink: stats.type === SFTP_FILE_TYPE_SYMLINK,
            mode: stats.permissions ?? 0,
            size: stats.size,
            modified: new Date((stats.mtime ?? 0) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const handleId: string = await this.ipc.invoke('ssh:session:sftp-open', this.sessionId, p, mode)
        return new SFTPFileHandle(this.sessionId, handleId, this.ipc)
    }

    async rmdir (p: string): Promise<void> {
        await this.ipc.invoke('ssh:session:sftp-rmdir', this.sessionId, p)
    }

    async mkdir (p: string): Promise<void> {
        await this.ipc.invoke('ssh:session:sftp-mkdir', this.sessionId, p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await this.ipc.invoke('ssh:session:sftp-rename', this.sessionId, oldPath, newPath)
    }

    async unlink (p: string): Promise<void> {
        await this.ipc.invoke('ssh:session:sftp-unlink', this.sessionId, p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        await this.ipc.invoke('ssh:session:sftp-chmod', this.sessionId, p, typeof mode === 'string' ? parseInt(mode, 8) : mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', path)
        const tempPath = path + '.tabby-upload'
        try {
            const handle = await this.open(tempPath, SFTP_OPEN_WRITE | SFTP_OPEN_CREATE)
            while (true) {
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
            }
            await handle.close()
            await this.unlink(path).catch(() => null)
            await this.rename(tempPath, path)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            this.unlink(tempPath).catch(() => null)
            throw e
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        try {
            const handle = await this.open(path, SFTP_OPEN_READ)
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            transfer.close()
            handle.close()
        } catch (e) {
            transfer.cancel()
            throw e
        }
    }

    private _makeFile (p: string, entry: { name: string; metadata: { type: number; permissions: number; size: number; mtime: number } }): SFTPFile {
        return {
            fullPath: p,
            name: posixBasename(p),
            isDirectory: entry.metadata.type === SFTP_FILE_TYPE_DIRECTORY,
            isSymlink: entry.metadata.type === SFTP_FILE_TYPE_SYMLINK,
            mode: entry.metadata.permissions ?? 0,
            size: entry.metadata.size,
            modified: new Date((entry.metadata.mtime ?? 0) * 1000),
        }
    }
}
