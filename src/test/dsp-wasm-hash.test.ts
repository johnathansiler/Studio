import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DSP_WASM_BASE64, DSP_WASM_BYTE_LENGTH } from '../audio/wasm/dspBytes'
import { dspWasmBytes } from '../audio/wasm/engine'

describe('committed DSP module', () => {
  it('matches the recorded sha256 of the Rust build', () => {
    const recorded = readFileSync('src/audio/wasm/dspBytes.sha256', 'utf8').trim().split(/\s+/)[0]
    const bytes = dspWasmBytes()
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(bytes.byteLength).toBe(DSP_WASM_BYTE_LENGTH)
    expect(Buffer.from(DSP_WASM_BASE64, 'base64').byteLength).toBe(DSP_WASM_BYTE_LENGTH)
    expect(hash).toBe(recorded)
    expect(recorded).toMatch(/^[a-f0-9]{64}$/)
  })
})
