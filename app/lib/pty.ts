import * as nodePTY from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { UTF8Splitter } from './utfSplitter'
import { Subject, debounceTime } from 'rxjs'
/* eslint-disable block-scoped-var */
let psNode: any = null
try {
    // eslint-disable-next-line no-var
    psNode = require('ps-node')
} catch { }
try {
    // eslint-disable-next-line no-var
    var macOSNativeProcessList = require('macos-native-processlist')
} catch { }

try {
    // eslint-disable-next-line no-var
    var windowsProcessTree = require('@tabby-gang/windows-process-tree')
} catch { }
/* eslint-enable block-scoped-var */

let getWorkingDirectoryFromPID: ((pid: number) => string | null) | null = null
try {
    getWorkingDirectoryFromPID = require('native-process-working-directory').getWorkingDirectoryFromPID
} catch { }

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024 * 100
    private maxDelta = this.maxChunk * 5
    private flowPaused = false
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    push (data: Buffer) {
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        this.delta -= length
        this.maybeEmit()
    }

    private maybeEmit () {
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta && !this.flowPaused) {
                this.pause()
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.emitData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                setImmediate(() => this.maybeEmit())
            }
        }
    }

    private emitData (data: Buffer) {
        const validChunk = this.decoder.write(data)
        this.onData(validChunk)
        this.output$.next(validChunk)
    }

    private pause () {
        this.pty.pause()
        this.flowPaused = true
    }

    private resume () {
        this.pty.resume()
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    exited = false

    constructor (private id: string, private app: Application, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs) => this.emit(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data', data))
        })

        this.pty.onData(data => this.outputQueue.push(Buffer.from(data)))
        this.pty.onExit(() => {
            this.exited = true
        })
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if ((this.pty as any)._writable) {
            this.pty.resize(columns, rows)
        }
    }

    write (buffer: Buffer): void {
        if ((this.pty as any)._writable) {
            this.pty.write(buffer as any)
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    kill (signal?: string): void {
        this.pty.kill(signal)
    }

    private emit (event: string, ...args: any[]) {
        this.app.broadcast(`pty:${this.id}:${event}`, ...args)
    }
}

export class PTYManager {
    private ptys: Record<string, PTY|undefined> = {}

    init (app: Application): void {
        ipcMain.removeHandler('pty:spawn')
        ipcMain.handle('pty:spawn', (_event, ...options) => {
            const id = uuidv4().toString()
            this.ptys[id] = new PTY(id, app, ...options)
            return id
        })

        ipcMain.removeHandler('pty:exists')
        ipcMain.handle('pty:exists', (_event, id) => !!(this.ptys[id] && !this.ptys[id].exited))

        ipcMain.removeHandler('pty:get-pid')
        ipcMain.handle('pty:get-pid', (_event, id) => this.ptys[id]?.getPID() ?? null)

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys[id]?.resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys[id]?.write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            this.ptys[id]?.kill(signal)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys[id]?.ackData(length)
        })

        ipcMain.removeHandler('pty:get-child-processes')
        ipcMain.handle('pty:get-child-processes', async (_event, truePID: number) => {
            if (process.platform === 'darwin') {
                const processes = await macOSNativeProcessList.getProcessList()  // eslint-disable-line block-scoped-var
                return processes.filter(x => x.ppid === truePID).map(p => ({
                    pid: p.pid,
                    ppid: p.ppid,
                    command: p.name,
                }))
            }
            if (process.platform === 'win32') {
                return new Promise(resolve => {
                    windowsProcessTree.getProcessTree(truePID, tree => {  // eslint-disable-line block-scoped-var
                        resolve(tree ? tree.children.map(child => ({
                            pid: child.pid,
                            ppid: tree.pid,
                            command: child.name,
                        })) : [])
                    })
                })
            }
            if (!psNode) {
                return []
            }
            return new Promise((resolve, reject) => {
                psNode.lookup({ ppid: truePID }, (err, processes) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(processes.map((p: any) => ({
                        pid: Number(p.pid),
                        ppid: Number(p.ppid),
                        command: p.command,
                    })))
                })
            })
        })

        ipcMain.removeHandler('pty:get-working-directory')
        ipcMain.handle('pty:get-working-directory', (_event, pid: number) => {
            if (!getWorkingDirectoryFromPID) { return null } // eslint-disable-line block-scoped-var
            try {
                return getWorkingDirectoryFromPID(pid) // eslint-disable-line block-scoped-var
            } catch {
                // Process already exited — expected race condition, not an error
                return null
            }
        })
    }
}
