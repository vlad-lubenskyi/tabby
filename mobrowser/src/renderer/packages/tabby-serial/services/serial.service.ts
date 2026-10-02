import { Injectable, Injector } from '@angular/core'
import { ProfilesService } from 'tabby-core'
import type { PartialProfile } from 'tabby-core'
import type { SerialPortInfo, SerialProfile } from '../api'
import { SerialTabComponent } from '../components/serialTab.component'

export interface WebSerialPort {
    readable: ReadableStream<Uint8Array>|null
    writable: WritableStream<Uint8Array>|null
    getInfo (): { usbVendorId?: number; usbProductId?: number }
    open (options: {
        baudRate: number
        dataBits: number
        stopBits: number
        parity: string
        flowControl: string
    }): Promise<void>
    close (): Promise<void>
}

interface WebSerial {
    getPorts (): Promise<WebSerialPort[]>
    requestPort (): Promise<WebSerialPort>
}

@Injectable({ providedIn: 'root' })
export class SerialService {
    private ports = new Map<string, WebSerialPort>()

    private constructor (
        private injector: Injector,
    ) { }

    private get api (): WebSerial {
        const serial = (navigator as Navigator & { serial?: WebSerial }).serial
        if (!serial) throw new Error('Web Serial is not available')
        return serial
    }

    private remember (port: WebSerialPort, index: number): SerialPortInfo {
        const info = port.getInfo()
        const vendor = info.usbVendorId?.toString(16).padStart(4, '0') ?? 'unknown'
        const product = info.usbProductId?.toString(16).padStart(4, '0') ?? 'unknown'
        const name = `webserial://${vendor}:${product}:${index}`
        this.ports.set(name, port)
        return { name, description: `USB ${vendor}:${product}` }
    }

    async listPorts (): Promise<SerialPortInfo[]> {
        try {
            this.ports.clear()
            return (await this.api.getPorts()).map((port, index) => this.remember(port, index))
        } catch (err) {
            console.error('Failed to list serial ports', err)
            return []
        }
    }

    async open (name: string, options: SerialProfile['options']): Promise<{ name: string; port: WebSerialPort }> {
        let port = this.ports.get(name)
        let portName = name
        if (!port) {
            port = await this.api.requestPort()
            portName = this.remember(port, this.ports.size).name
        }
        await port.open({
            baudRate: options.baudrate ?? 115200,
            dataBits: options.databits,
            stopBits: options.stopbits,
            parity: options.parity,
            flowControl: options.rtscts ? 'hardware' : 'none',
        })
        // ponytail: Web Serial has no xon/xoff/xany controls; add serial IPC if software flow control is required.
        return { name: portName, port }
    }

    quickConnect (query: string): Promise<SerialTabComponent|null> {
        let path = query
        let baudrate = 115200
        if (query.includes('@')) {
            baudrate = parseInt(path.split('@')[1])
            path = path.split('@')[0]
        }
        const profile: PartialProfile<SerialProfile> = {
            name: query,
            type: 'serial',
            options: {
                port: path,
                baudrate: baudrate,
            },
        }
        window.localStorage.lastSerialConnection = JSON.stringify(profile)
        return this.injector.get(ProfilesService).openNewTabForProfile(profile) as Promise<SerialTabComponent|null>
    }
}
