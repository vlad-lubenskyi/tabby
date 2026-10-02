// Derived from: tabby-ssh/src/session/forwards.ts
import { PortForwardType } from '../api'
import type { ForwardedPortConfig } from '../api'

export class ForwardedPort implements ForwardedPortConfig {
    type: PortForwardType = PortForwardType.Local
    host = '127.0.0.1'
    port = 0
    targetAddress = ''
    targetPort = 0
    description = ''

    async startLocalListener (_callback: (accept: () => unknown, reject: () => void, sourceAddress: string | null, sourcePort: number | null, targetAddress: string, targetPort: number) => void): Promise<void> {
        // Port forwarding is handled by the main process (SSH service)
    }

    stopLocalListener (): void {
        // no-op
    }

    toString (): string {
        if (this.type === PortForwardType.Local) {
            return `(local) ${this.host}:${this.port} → (remote) ${this.targetAddress}:${this.targetPort}`
        }
        if (this.type === PortForwardType.Remote) {
            return `(remote) ${this.host}:${this.port} → (local) ${this.targetAddress}:${this.targetPort}`
        }
        return `(dynamic) ${this.host}:${this.port}`
    }
}
