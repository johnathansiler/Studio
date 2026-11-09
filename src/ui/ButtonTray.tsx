import type { ReactNode } from 'react'

/** Related buttons sit in one recessed tray. Equal spans only the top view switcher. */
export function ButtonTray({
  children,
  equal = false,
  label,
  className = '',
}: {
  children: ReactNode
  equal?: boolean
  label?: string
  className?: string
}) {
  return (
    <div
      className={['btn-tray', equal ? 'btn-tray-equal' : '', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  )
}
