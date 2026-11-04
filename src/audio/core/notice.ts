/** Status line. Not a dialog: it does not take clicks and it does not cover the mix. */

const NOTICE_ID = 'cueharbor-session-notice'

export function publishNotice(text: string) {
  if (typeof document === 'undefined') return
  const body = document.body
  if (!body) return
  let el = document.getElementById(NOTICE_ID)
  if (!text) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('div')
    el.id = NOTICE_ID
    el.setAttribute('role', 'status')
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:30;max-width:280px;padding:8px 10px;border-radius:8px;background:#1c2430;color:#e8eef7;font:12px/1.4 sans-serif;pointer-events:none'
    body.appendChild(el)
  }
  el.textContent = text
}
