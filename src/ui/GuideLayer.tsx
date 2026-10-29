import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

/** Sheets must paint above clips. A sticky header would otherwise trap them. */
export function GuideLayer({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return children
  return createPortal(children, document.body)
}
