import { useEffect, useRef } from 'react'
import type { ProjectStore } from '../state/store'
import { bindSwipeDismiss } from './swipeDismiss'

/** Floating messages. A sideways drag dismisses one. The stack does not take clicks. */
export function Toasts({ store }: { store: ProjectStore }) {
  return (
    <div className="toasts">
      {store.toasts.map((toast) => (
        <ToastLine key={toast.id} id={toast.id} text={toast.text} tone={toast.tone} store={store} />
      ))}
    </div>
  )
}

function ToastLine({ id, text, tone, store }: { id: string; text: string; tone?: string; store: ProjectStore }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return bindSwipeDismiss(el, () => store.dismissToast(id))
  }, [id, store])
  return (
    <div ref={ref} className={`toast ${tone || ''}`} role="status">
      {text}
    </div>
  )
}
