import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  controlWidth,
  fitSecondary,
  secondaryRowBudget,
  type SecondarySlot,
} from '../model/secondaryFit'

export interface SecondaryItem {
  id: string
  /** Full word used to reserve width. The visible control keeps this word. */
  label: string
  width?: number
  keep?: number
  node: ReactNode
}

/**
 * Secondary mixer controls. They wrap and stack as the strip narrows.
 * At the narrowest, the least-used move behind one More disclosure.
 * The drawer is in the strip, not a covering sheet.
 * A ResizeObserver follows the strip; container queries do the same from CSS.
 */
export function SecondaryRack({
  flow,
  zone,
  width,
  items,
  className = '',
}: {
  flow: 'columns' | 'rows'
  zone: 'tools' | 'hear' | 'top'
  width: number
  items: SecondaryItem[]
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const panelId = `more-${useId().replace(/:/g, '')}`
  const [measured, setMeasured] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    const strip = node?.closest('.strip') as HTMLElement | null
    if (!node || !strip || typeof ResizeObserver === 'undefined') return
    const read = () => {
      let next = node.clientWidth
      if (zone === 'top') {
        const style = getComputedStyle(strip)
        const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
        const name = strip.querySelector('.strip-name') as HTMLElement | null
        next = strip.clientWidth - pad - (name?.offsetWidth ?? 72) - 8
      }
      if (!(next > 0)) return
      setMeasured((prev) => (prev != null && Math.abs(prev - next) < 1 ? prev : next))
    }
    const observer = new ResizeObserver(read)
    observer.observe(strip)
    if (zone !== 'top') observer.observe(node)
    const name = zone === 'top' ? strip.querySelector('.strip-name') : null
    if (name) observer.observe(name)
    read()
    return () => observer.disconnect()
  }, [zone, items.length])
  const used = measured && measured > 0 ? measured : width
  const slots: SecondarySlot[] = items.map((item) => ({
    id: item.id,
    width: item.width ?? controlWidth(item.label),
    keep: item.keep,
  }))
  const fit = fitSecondary(used, slots, secondaryRowBudget(flow, zone, used))
  const hidden = new Set(fit.drawer)
  const shown = items.filter((item) => !hidden.has(item.id))
  const drawer = items.filter((item) => hidden.has(item.id))
  return (
    <div
      ref={ref}
      className={`strip-secondary${className ? ` ${className}` : ''}`}
      data-zone={zone}
      data-width={Math.round(used)}
      data-rows={fit.rows}
      data-shown={fit.shown.join(' ')}
      data-drawer={fit.drawer.join(' ')}
    >
      {shown.map((item) => (
        <div className="secondary-slot" data-slot={item.id} key={item.id}>{item.node}</div>
      ))}
      {drawer.length > 0 && (
        <details
          className="more-fold"
          open={open}
          onToggle={(event) => {
            event.stopPropagation()
            setOpen(event.currentTarget.open)
          }}
        >
          <summary className="mini more-open" aria-controls={panelId} aria-expanded={open} onClick={(event) => event.stopPropagation()}>
            <span className="mini-word">More</span>
          </summary>
          <div className="more-drawer" id={panelId} role="group" aria-label="More controls">
            {drawer.map((item) => (
              <div className="secondary-slot" data-slot={item.id} key={item.id}>{item.node}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
