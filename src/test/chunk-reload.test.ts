import { describe, expect, it, vi } from 'vitest'
import { installPreloadReload, preloadReloadDecision, rememberPreloadFailure } from '../ui/chunkReload'
import { missingExportMessage, refetchModule, retryChunkUrl } from '../ui/lazyViews'

describe('chunk retry url', () => {
  it('keeps the first import and cache-busts a failed one', () => {
    const message = 'Failed to fetch dynamically imported module: http://127.0.0.1:4377/src/ui/MixerView.tsx'
    expect(retryChunkUrl(message, 0)).toBeNull()
    expect(retryChunkUrl(message, 1)).toBe('http://127.0.0.1:4377/src/ui/MixerView.tsx?cueharbor-retry=1')
    expect(retryChunkUrl('missing', 1)).toBeNull()
  })
})

describe('stale chunk reload', () => {
  it('reloads once when a preload fails, then stays', () => {
    expect(preloadReloadDecision(null)).toBe('reload')
    expect(preloadReloadDecision('1')).toBe('stay')
    const storage = new Map<string, string>()
    const reloads: number[] = []
    let dispatch: (event: Event) => void = () => undefined
    const target = {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
      },
      location: { reload: () => { reloads.push(1) } },
      addEventListener: (_type: string, listener: (event: Event) => void) => {
        dispatch = listener
      },
    }
    installPreloadReload(target as unknown as Window)
    const event = new Event('vite:preloadError', { cancelable: true })
    const prevent = vi.spyOn(event, 'preventDefault')
    dispatch(event)
    expect(prevent).toHaveBeenCalledOnce()
    expect(reloads).toEqual([1])
    expect(storage.get('cueharbor-chunk-reload')).toBe('1')
    const again = new Event('vite:preloadError', { cancelable: true })
    const preventAgain = vi.spyOn(again, 'preventDefault')
    dispatch(again)
    expect(preventAgain).not.toHaveBeenCalled()
    expect(again.defaultPrevented).toBe(false)
    expect(reloads).toEqual([1])
  })
})

describe('a preload that resolves undefined', () => {
  it('treats the missing module as a failure and loads a new url', async () => {
    const message = 'Failed to fetch dynamically imported module: http://127.0.0.1:4173/assets/MixerView-abc.js'
    rememberPreloadFailure(message)
    expect(missingExportMessage(undefined, 'MixerView', message)).toBe(message)
    expect(missingExportMessage({ MixerView() { return null } }, 'MixerView')).toBeNull()
    const seen: string[] = []
    type MixModule = { MixerView: () => null }
    const missing = async (): Promise<MixModule | undefined> => undefined
    await expect(refetchModule(missing, 'MixerView', 0, async () => {
      throw new Error('first miss must not bust')
    })).rejects.toThrow(/MixerView/)
    const loaded = await refetchModule(missing, 'MixerView', 1, async (url) => {
      seen.push(url)
      return { MixerView() { return null } }
    })
    expect(seen).toEqual(['http://127.0.0.1:4173/assets/MixerView-abc.js?cueharbor-retry=1'])
    expect(loaded.default).toBeTypeOf('function')
  })
})
