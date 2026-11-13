const RELOAD_KEY = 'cueharbor-chunk-reload'

export function preloadReloadDecision(flag: string | null): 'reload' | 'stay' {
  return flag === '1' ? 'stay' : 'reload'
}

/** Reload once when Vite reports a stale chunk after a redeploy. */
export function installPreloadReload(target: Window = window) {
  target.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    let flag: string | null = null
    try {
      flag = target.sessionStorage.getItem(RELOAD_KEY)
    } catch {
      return
    }
    if (preloadReloadDecision(flag) === 'stay') return
    try {
      target.sessionStorage.setItem(RELOAD_KEY, '1')
    } catch {
      return
    }
    target.location.reload()
  })
}
