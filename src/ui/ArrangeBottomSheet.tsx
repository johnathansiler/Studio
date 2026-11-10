import { useEffect, type ReactNode } from 'react'
import { SheetGrab } from './bottomSheet'
import { SheetHeader } from './SheetClose'

/** Same bottom sheet Browser and Plugins use: header, Close, body scrolls, height follows short content. */
export function ArrangeBottomSheet({
  id,
  label,
  title,
  detail,
  onClose,
  children,
}: {
  id: string
  label: string
  title: string
  detail?: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <section
      id={id}
      className="bottom-sheet arrange-sheet"
      data-bottom-sheet="open"
      data-arrange-sheet={id}
      role="dialog"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <SheetGrab label={`Resize ${title}. Drag up or down.`} />
      <SheetHeader
        className="arrange-sheet-head"
        title={<strong>{title}</strong>}
        detail={detail ? <span>{detail}</span> : null}
        onClose={onClose}
      />
      <div className="bottom-sheet-body">{children}</div>
    </section>
  )
}
