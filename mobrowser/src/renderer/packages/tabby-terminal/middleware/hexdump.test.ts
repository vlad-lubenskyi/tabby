import assert from 'node:assert/strict'
import test from 'node:test'
import { hexdump } from './hexdump.ts'

test('formats bytes in 16-byte rows', () => {
    assert.equal(hexdump(Uint8Array.from([0, 65, 255])), '  00: 00 41 ff                                        ｜ .A.╳╳╳╳╳╳╳╳╳╳╳╳╳')
})
