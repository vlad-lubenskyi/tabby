import assert from 'node:assert/strict'
import * as net from 'node:net'
import test from 'node:test'
import { telnetService } from './telnet.ts'

test('Telnet service connects, streams, writes, and closes', async () => {
  let receivedResolve!: (data: Uint8Array) => void
  const received = new Promise<Uint8Array>(resolve => { receivedResolve = resolve })
  const server = net.createServer(socket => {
    socket.write(new Uint8Array([1, 2, 3]))
    socket.once('data', data => receivedResolve(data))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  assert(address && typeof address !== 'string')
  const abort = new AbortController()
  const events = telnetService.Connect(
    { sessionId: 'test', host: '127.0.0.1', port: address.port },
    { signal: abort.signal } as never,
  )[Symbol.asyncIterator]()

  assert.equal((await events.next()).value?.connected, true)
  assert.deepEqual((await events.next()).value?.data, Buffer.from([1, 2, 3]))
  await telnetService.Write({ sessionId: 'test', data: Buffer.from([4, 5, 6]) }, {} as never)
  assert.deepEqual(await received, Buffer.from([4, 5, 6]))
  await telnetService.Destroy({ sessionId: 'test' }, {} as never)
  assert.equal((await events.next()).value?.closed, true)

  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})
