// Derived from: tabby-ssh/src/session/sftp.ts
import { Subject, Observable } from 'rxjs'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'
import { ipc } from '@gen/ipc'

const SFTP_FILE_TYPE_DIRECTORY = 2
const SFTP_FILE_TYPE_SYMLINK = 3
const SFTP_OPEN_READ = 1
const SFTP_OPEN_WRITE = 2
const SFTP_OPEN_CREATE = 8

function posixJoin (base: string, name: string): string {
    if (!base.endsWith('/')) {
        return base + '/' + name
    }
    return base + name
}

function posixBasename (p: string): string {
    return p.split('/').filter(Boolean).pop() ?? p
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

    constructor (private sessionId: string, private handleId: string) {}

    async read (): Promise<Uint8Array> {
        const result = await ipc.ssh.SftpRead({ sessionId: this.sessionId, handleId: this.handleId, length: 256 * 1024 })
        return result.data
    }

    async write (chunk: Uint8Array): Promise<void> {
        await ipc.ssh.SftpWrite({ sessionId: this.sessionId, handleId: this.handleId, data: chunk })
    }

    async close (): Promise<void> {
        await ipc.ssh.SftpClose({ sessionId: this.sessionId, handleId: this.handleId })
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private logger: Logger

    constructor (private sessionId: string, injector: Injector, sessionClose$: Observable<void>) {
        this.logger = injector.get(LogService).create('sftp')
        sessionClose$.subscribe(() => {
            this.closed.next()
            this.closed.complete()
        })
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const result = await ipc.ssh.SftpReaddir({ sessionId: this.sessionId, path: p })
        return result.entries.map(e => ({
            name: e.name,
            fullPath: posixJoin(p, e.name),
            isDirectory: e.fileType === SFTP_FILE_TYPE_DIRECTORY,
            isSymlink: e.fileType === SFTP_FILE_TYPE_SYMLINK,
            mode: e.permissions,
            size: Number(e.size),
            modified: new Date(Number(e.mtime) * 1000),
        }))
    }

    async readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        const result = await ipc.ssh.SftpReadlink({ sessionId: this.sessionId, path: p })
        return result.value
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await ipc.ssh.SftpStat({ sessionId: this.sessionId, path: p })
        return {
            name: posixBasename(p),
            fullPath: p,
            isDirectory: stats.fileType === SFTP_FILE_TYPE_DIRECTORY,
            isSymlink: stats.fileType === SFTP_FILE_TYPE_SYMLINK,
            mode: stats.permissions,
            size: Number(stats.size),
            modified: new Date(Number(stats.mtime) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const result = await ipc.ssh.SftpOpen({ sessionId: this.sessionId, path: p, flags: mode })
        return new SFTPFileHandle(this.sessionId, result.handleId)
    }

    async rmdir (p: string): Promise<void> {
        await ipc.ssh.SftpRmdir({ sessionId: this.sessionId, path: p })
    }

    async mkdir (p: string): Promise<void> {
        await ipc.ssh.SftpMkdir({ sessionId: this.sessionId, path: p })
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await ipc.ssh.SftpRename({ sessionId: this.sessionId, oldPath, newPath })
    }

    async unlink (p: string): Promise<void> {
        await ipc.ssh.SftpUnlink({ sessionId: this.sessionId, path: p })
    }

    async chmod (p: string, mode: string | number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        const modeNum = typeof mode === 'string' ? parseInt(mode, 8) : mode
        await ipc.ssh.SftpChmod({ sessionId: this.sessionId, path: p, mode: modeNum })
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
}
