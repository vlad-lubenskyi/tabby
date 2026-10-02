export function hexdump (data: Uint8Array): string {
    const lines: string[] = []
    const offsetWidth = Math.max(2, 2 * Math.ceil(data.length.toString(16).length / 2))

    for (let offset = 0; offset < data.length; offset += 16) {
        const bytes = data.subarray(offset, offset + 16)
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47)
        const text = Array.from(bytes, byte => byte > 0x1f && byte < 0x7f ? String.fromCharCode(byte) : '.')
            .join('')
            .padEnd(16, '╳')
        lines.push(`${offset.toString(16).padStart(offsetWidth, '0').padStart(4)}: ${hex} ｜ ${text}`)
    }

    return lines.join('\n')
}
