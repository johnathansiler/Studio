const RELOAD_KEY = 'cueharbor-chunk-reload'

let lastPreloadMessage = ''

export function preloadReloadDecision(flag: string | null): 'reload' | 'stay' {
  return flag === '1' ? 'stay' : 'reload'
}

/** The last preload error. A swallowed failure resolves the import to undefined, and Retry still needs the chunk URL. */
export function rememberPreloadFailure(message: string) {
  if (message) lastPreloadMessage = message
}

export function lastPreloadFailure() {
  return lastPreloadMessage
}

function payloadMessage(event: Event) {
  const payload = (event as Event & { payload?: unknown }).payload
  if (payload instanceof Error) return payload.message
  return typeof payload === 'string' ? payload : ''
}

/**
 * Reload once when Vite reports a stale chunk after a redeploy.
 * preventDefault only on that reload. Leaving the event alone lets the
 * dynamic import reject. Preventing it makes Vite resolve the import to undefined.
 */
export function installPreloadReload(target: Window = window) {
  target.addEventListener('vite:preloadError', (event) => {
    rememberPreloadFailure(payloadMessage(event))
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
    event.preventDefault()
    target.location.reload()
  })
}
