import { describe, expect, it } from 'vitest'
import { assertWorkletSource, bundleWorklet } from '../../scripts/worklet-bundle'

const ENTRIES = [
  'src/audio/library.worklet.ts',
  'src/audio/patch.worklet.ts',
  'src/audio/rack/rack.worklet.ts',
  'src/audio/insert.worklet.ts',
  'src/audio/wasm/eq.worklet.ts',
  'src/audio/stretch/worklet-entry.ts',
]

describe('worklet bundles', () => {
  it('emits one file with no import for every worklet entry', async () => {
    for (const entry of ENTRIES) {
      const code = await bundleWorklet(entry)
      expect(code.length).toBeGreaterThan(50)
      expect(() => assertWorkletSource(code, entry)).not.toThrow()
      expect(code.includes('import(')).toBe(false)
      expect(/(^|[\n;])\s*import[\s{"'*]/.test(code)).toBe(false)
    }
  }, 180000)
})
