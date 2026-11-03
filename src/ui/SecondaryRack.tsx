import type { ReactNode } from 'react'

export interface SecondaryItem {
  id: string
  /** Full word used to reserve width. The visible control keeps this word. */
  label: string
  width?: number
  keep?: number
  node: ReactNode
}

/**
 * Secondary mixer controls. Every one is on the strip, stacked.
 * The band scrolls when they do not fit. The volume fader is outside this band,
 * so opening or scrolling these controls cannot shrink it.
 */
export function SecondaryRack({
  zone,
  items,
  className = '',
}: {
  zone: 'tools' | 'hear' | 'top'
  items: SecondaryItem[]
  className?: string
}) {
  return (
    <div
      className={`strip-secondary${className ? ` ${className}` : ''}`}
      data-zone={zone}
      data-shown={items.map((item) => item.id).join(' ')}
      data-drawer=""
    >
      {items.map((item) => (
        <div className="secondary-slot" data-slot={item.id} key={item.id}>{item.node}</div>
      ))}
    </div>
  )
}
