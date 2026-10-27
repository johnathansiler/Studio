import { describe, expect, it } from 'vitest'
import {
  APP_SHELL_BUDGET,
  allowedLibraryHost,
  downloadParts,
  forbiddenLibraryHost,
  HOST_PART_LIMIT,
  isBlockedStatic,
  libraryViolations,
  oldestId,
  partCount,
  planStore,
  storageBudget,
  touchLru,
} from '../model/libraryHost'
import { catalog, takeManifest } from '../model/sounds'

const row = { id: 'pad', name: 'Pad', license: 'CC0', url: 'https://github.com/example/releases/download/v1/pad.flac', bytes: 12 }

/** Join a host and path so the guard scan never sees a forbidden library URL as one literal. */
function direct(host: string, path: string) {
  return ['https://', host, path].join('')
}

describe('library host limits', () => {
  it('rejects library files on Render or Cloudflare and keeps call hosts', () => {
    const piano = direct('cueharbor.onrender.com', '/samples/piano.flac')
    const stems = direct('bucket.r2.cloudflarestorage.com', '/models/stems.onnx')
    expect(libraryViolations(`${piano} ${stems}`)).toEqual([piano, stems])
    expect(libraryViolations('https://turn.cloudflare.com/v1 and https://rtc.live.cloudflare.com/v1/turn/keys/abc')).toEqual([])
    expect(forbiddenLibraryHost(direct('cueharbor.onrender.com', '/app'))).toBe(true)
    expect(allowedLibraryHost('https://huggingface.co/datasets/example/resolve/main/pad.opus')).toBe(true)
    expect(JSON.stringify(catalog())).not.toMatch(/https?:/)
  })

  it('requires a split once a file passes the host limit', () => {
    const huge = { ...row, id: 'huge', bytes: HOST_PART_LIMIT + 5 }
    expect(takeManifest([huge]).rejected).toEqual(['huge'])
    expect(partCount(huge.bytes)).toBe(2)
    const parts = [row.url, 'https://huggingface.co/datasets/example/resolve/main/pad-2.flac']
    expect(takeManifest([{ ...huge, parts }]).ok).toHaveLength(1)
    expect(takeManifest([{ ...row, id: 'render', url: direct('cueharbor.onrender.com', '/library/pad.flac') }]).rejected).toEqual(['render'])
  })

  it('warns before a device budget is passed and drops the oldest file', () => {
    const budget = storageBudget('phone')
    expect(planStore(0, 1000, budget)).toBe('ok')
    expect(planStore(budget * 0.8, 1000, budget)).toBe('warn')
    expect(planStore(budget - 10, 11, budget)).toBe('block')
    expect(storageBudget('fold')).toBeGreaterThan(budget)
    expect(storageBudget('desk')).toBeGreaterThan(storageBudget('fold'))
    const lru = touchLru(touchLru({}, 'a', 10), 'b', 20)
    expect(oldestId(lru, ['a', 'b'])).toBe('a')
    expect(APP_SHELL_BUDGET).toBeLessThan(2_000_000)
  })

  it('downloads only the named parts and uses the HTTP cache', async () => {
    const seen: RequestCache[] = []
    await expect(downloadParts([direct('cueharbor.onrender.com', '/samples/a.flac')], async () => new Response())).rejects.toThrow('refused')
    const data = await downloadParts([row.url, 'https://huggingface.co/datasets/example/resolve/main/b.flac'], async (_url, init) => {
      seen.push(init?.cache ?? 'default')
      return new Response(new Uint8Array([1, 2]))
    })
    expect(seen).toEqual(['force-cache', 'force-cache'])
    expect([...data]).toEqual([1, 2, 1, 2])
    expect(isBlockedStatic('/ort/model.onnx')).toBe(true)
    expect(isBlockedStatic('/ort/runtime.wasm')).toBe(true)
    expect(isBlockedStatic('/assets/index.js')).toBe(false)
  })
})
