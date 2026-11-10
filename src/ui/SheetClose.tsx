import type { ReactNode } from 'react'
import './sheetClose.css'

/** Square hit target. The mark is an X; the accessible name stays Close. */
export function SheetClose({ onClick, label = 'Close', className = '' }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button type="button" className={['sheet-close', 'overlay-close', className].filter(Boolean).join(' ')} aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/** Shared sheet header. Select, Snap, Setup, and the other bottom sheets use this row. */
export function SheetHeader({
  title,
  detail,
  onClose,
  closeLabel = 'Close',
  className = '',
}: {
  title: ReactNode
  detail?: ReactNode
  onClose: () => void
  closeLabel?: string
  className?: string
}) {
  return (
    <header className={['sheet-head', className].filter(Boolean).join(' ')}>
      <div className="sheet-head-copy">
        {title}
        {detail}
      </div>
      <SheetClose onClick={onClose} label={closeLabel} />
    </header>
  )
}
