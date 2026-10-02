import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = new Uint8Array([0x1b, 0x5d])           // ESC ]
const OSCSuffixes = [new Uint8Array([0x07]), new Uint8Array([0x1b, 0x5c])] // BEL, ESC \

function indexOfPattern (haystack: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
    if (needle.length === 0) return fromIndex
    outer: for (let i = fromIndex; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer
        }
        return i
    }
    return -1
}

function concatUint8 (...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((n, a) => n + a.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const a of arrays) { result.set(a, offset); offset += a.length }
    return result
}

const _dec = new TextDecoder()

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }

    private cwdReported = new Subject<string>()
    private buffer: Uint8Array | null = null
    private copyRequested = new Subject<string>()

    feedFromSession (data: Uint8Array): void {
        // Prepend any buffered data from previous chunks
        if (this.buffer) {
            data = concatUint8(this.buffer, data)
            this.buffer = null
        }

        let startIndex = 0
        const processedData: Uint8Array[] = []

        while (startIndex < data.length) {
            const prefixIndex = indexOfPattern(data, OSCPrefix, startIndex)

            if (prefixIndex === -1) {
                // No more OSC sequences, pass remaining data
                if (startIndex < data.length) {
                    processedData.push(data.subarray(startIndex))
                }
                break
            }

            // Pass data before this OSC sequence
            if (prefixIndex > startIndex) {
                processedData.push(data.subarray(startIndex, prefixIndex))
            }

            // Look for suffix after the prefix
            const suffixSearchStart = prefixIndex + OSCPrefix.length
            let foundSuffix: [Uint8Array, number] | null = null

            for (const suffix of OSCSuffixes) {
                const suffixIndex = indexOfPattern(data, suffix, suffixSearchStart)
                if (suffixIndex !== -1) {
                    if (!foundSuffix || suffixIndex < foundSuffix[1]) {
                        foundSuffix = [suffix, suffixIndex]
                    }
                }
            }

            if (!foundSuffix) {
                // No suffix found - buffer the rest and wait for next chunk
                this.buffer = data.subarray(prefixIndex)
                break
            }

            // Extract OSC string (between prefix and suffix)
            const oscString = _dec.decode(data.subarray(suffixSearchStart, foundSuffix[1]))
            const [oscCodeString, ...oscParams] = oscString.split(';')
            const oscCode = parseInt(oscCodeString)

            if (oscCode === 1337) {
                const paramString = oscParams.join(';')
                if (paramString.startsWith('CurrentDir=')) {
                    let reportedCWD = paramString.split('=', 2)[1]
                    if (reportedCWD.startsWith('~')) {
                        const homeDir = (window as any).tabbyAPI?.env?.HOME ?? (window as any).tabbyAPI?.env?.USERPROFILE ?? '~'
                        reportedCWD = homeDir + reportedCWD.substring(1)
                    }
                    this.cwdReported.next(reportedCWD)
                } else {
                    console.debug('Unsupported OSC 1337 parameter:', paramString)
                }
            } else if (oscCode === 52) {
                if (oscParams[0] === 'c' || oscParams[0] === '') {
                    const content = Uint8Array.from(atob(oscParams[1]), c => c.charCodeAt(0))
                    this.copyRequested.next(_dec.decode(content))
                }
            } else {
                processedData.push(data.subarray(prefixIndex, foundSuffix[1] + foundSuffix[0].length))
            }

            // Move past this OSC sequence
            startIndex = foundSuffix[1] + foundSuffix[0].length
        }

        // Pass through all processed data
        if (processedData.length > 0) {
            super.feedFromSession(concatUint8(...processedData))
        }
    }

    close (): void {
        this.cwdReported.complete()
        this.copyRequested.complete()
        super.close()
    }
}
