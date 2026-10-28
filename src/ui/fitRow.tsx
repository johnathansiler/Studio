import { Children, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * One toolbar row. What does not fit moves behind a beveled More button
 * in the same row, so nothing wraps and nothing pops over the work.
 */
export function FitRow({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const items = useMemo(() => Children.toArray(children), [children])
  const [page, setPage] = useState(0)
  const [starts, setStarts] = useState<number[]>([0])

  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    const measure = () => {
      const nodes = [...row.querySelectorAll<HTMLElement>(':scope > .fit-item')]
      if (!nodes.length) return
      const wasHidden = nodes.map((node) => node.hidden)
      const more = row.querySelector<HTMLElement>(':scope > .fit-more')
      const moreHidden = more?.hidden
      nodes.forEach((node) => { node.hidden = false })
      if (more) more.hidden = true
      const gap = 4
      const widths = nodes.map((node) => node.getBoundingClientRect().width)
      const avail = row.clientWidth
      const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
      const next = [0]
      if (total > avail + 1) {
        const reserve = 72
        let used = 0
        for (let index = 0; index < widths.length; index += 1) {
          const width = widths[index] + (used > 0 ? gap : 0)
          if (used > 0 && used + width > avail - reserve) {
            next.push(index)
            used = widths[index]
          } else used += width
        }
      }
      nodes.forEach((node, index) => { node.hidden = wasHidden[index] })
      if (more && moreHidden != null) more.hidden = moreHidden
      setStarts((prev) => (prev.length === next.length && prev.every((value, index) => value === next[index]) ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [items.length])

  const safePage = Math.min(page, Math.max(0, starts.length - 1))
  const from = starts[safePage] ?? 0
  const to = starts[safePage + 1] ?? items.length
  const overflow = starts.length > 1
  const last = safePage > 0 && safePage === starts.length - 1

  return (
    <div ref={ref} className={`fit-row ${className ?? ''}`}>
      {items.map((child, index) => (
        <span key={index} className="fit-item" hidden={overflow && (index < from || index >= to)}>
          {child}
        </span>
      ))}
      {overflow && (
        <button
          type="button"
          className={`fit-more${safePage > 0 ? ' on' : ''}`}
          aria-pressed={safePage > 0}
          title={last ? 'Back to the first tools.' : 'More tools. They stay in this row.'}
          onClick={() => setPage((safePage + 1) % starts.length)}
        >
          {last ? 'Back' : 'More'}
        </button>
      )}
    </div>
  )
}
