import { describe, expect, it, vi } from 'vitest'
import { installPreloadReload, preloadReloadDecision } from '../ui/chunkReload'
import { retryChunkUrl } from '../ui/lazyViews'

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
    const event = new Event('vite:preloadError')
    const prevent = vi.spyOn(event, 'preventDefault')
    dispatch(event)
    expect(prevent).toHaveBeenCalled()
    expect(reloads).toEqual([1])
    expect(storage.get('cueharbor-chunk-reload')).toBe('1')
    dispatch(new Event('vite:preloadError'))
    expect(reloads).toEqual([1])
  })
})
