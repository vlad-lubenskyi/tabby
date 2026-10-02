import * as net from 'node:net'
import type { TelnetService } from './gen/ipc_service'
import type { TelnetEvent } from './gen/telnet'

const sessions = new Map<string, net.Socket>()

export const telnetService: TelnetService = {
  async *Connect({ sessionId, host, port }, ctx) {
    if (!sessionId || !host || port < 1 || port > 65535) {
      throw new Error('Invalid Telnet connection parameters')
    }
    if (sessions.has(sessionId)) {
      throw new Error(`Telnet session already exists: ${sessionId}`)
    }

    const socket = net.createConnection({ host, port })
    sessions.set(sessionId, socket)

    let finished = false
    const events = new ReadableStream<TelnetEvent>({
      start(controller) {
        const finish = (event?: TelnetEvent) => {
          if (finished) return
          finished = true
          if (event) controller.enqueue(event)
          controller.close()
        }

        socket.on('connect', () => controller.enqueue({ data: Buffer.alloc(0), connected: true, closed: false, error: '' }))
        socket.on('data', data => controller.enqueue({ data, connected: false, closed: false, error: '' }))
        socket.on('error', error => finish({ data: Buffer.alloc(0), connected: false, closed: false, error: error.message }))
        socket.on('close', () => finish({ data: Buffer.alloc(0), connected: false, closed: true, error: '' }))
        ctx.signal.addEventListener('abort', () => socket.destroy(), { once: true })
      },
    })

    try {
      const reader = events.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          yield value
        }
      } finally {
        reader.releaseLock()
      }
    } finally {
      sessions.delete(sessionId)
      socket.destroy()
    }
  },

  async Write({ sessionId, data }) {
    const socket = sessions.get(sessionId)
    if (!socket) throw new Error(`No Telnet session: ${sessionId}`)
    await new Promise<void>((resolve, reject) => socket.write(data, error => error ? reject(error) : resolve()))
    return {}
  },

  async Destroy({ sessionId }) {
    sessions.get(sessionId)?.destroy()
    sessions.delete(sessionId)
    return {}
  },
}
