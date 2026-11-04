/** Status line. A sideways drag dismisses it. It leaves the page after a few seconds. */

import { bindSwipeDismiss } from '../../ui/swipeDismiss'

const NOTICE_ID = 'cueharbor-session-notice'
const NOTICE_MS = 4500

let timer = 0
let unbind: (() => void) | null = null

export function publishNotice(text: string) {
  if (typeof document === 'undefined') return
  const body = document.body
  if (!body) return
  window.clearTimeout(timer)
  let el = document.getElementById(NOTICE_ID)
  if (!text) {
    unbind?.()
    unbind = null
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('div')
    el.id = NOTICE_ID
    el.setAttribute('role', 'status')
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:30;max-width:min(320px,calc(100vw - 24px));padding:8px 10px;border-radius:8px;background:#1c2430;color:#e8eef7;font:12px/1.4 sans-serif;pointer-events:auto;touch-action:pan-y'
    body.appendChild(el)
    unbind = bindSwipeDismiss(el, () => publishNotice(''))
  }
  el.textContent = text
  timer = window.setTimeout(() => publishNotice(''), NOTICE_MS)
}
