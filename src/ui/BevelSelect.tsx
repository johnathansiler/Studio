import { useEffect, useState, type ReactNode } from 'react'
import { useFormFactor } from './form'
import { GuideLayer } from './GuideLayer'
import './guideSheet.css'

export interface BevelOption {
  value: string
  label: string
}

/**
 * Phone and fold open an in-app list. A native select popup on Android
 * lets the tap fall through onto the control underneath.
 */
export function BevelSelect({
  label,
  hint,
  value,
  options,
  onChange,
  className,
  children,
}: {
  label: string
  hint?: string
  value: string
  options: BevelOption[]
  onChange: (value: string) => void
  className?: string
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const form = useFormFactor()
  const current = options.find((item) => item.value === value)?.label ?? value
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (form === 'desk') {
    return (
      <select
        className={className}
        aria-label={label}
        title={hint ?? label}
        value={value}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
    )
  }
  return (
    <>
      <button
        type="button"
        className={`bevel-select ${className ?? ''}`.trim()}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}. ${current}.`}
        title={hint ?? label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        {children ?? current}
      </button>
      {open && (
        <GuideLayer>
          <button
            type="button"
            className="guide-scrim picker-scrim"
            aria-label={`Close ${label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }}
          />
          <div className="guide-sheet sheet bevel-picker" role="dialog" aria-label={label} data-picker={label} onPointerDown={(event) => event.stopPropagation()}>
            <div className="guide-handle" aria-hidden="true" />
            <header className="guide-head">
              <div>
                <h2>{label}</h2>
                {hint && <p>{hint}</p>}
              </div>
              <button type="button" className="guide-x" onClick={() => setOpen(false)} aria-label={`Close ${label}`}>Cancel</button>
            </header>
            <div className="guide-cards bevel-options">
              {options.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`guide-choice${item.value === value ? ' on' : ''}`}
                  aria-pressed={item.value === value}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onChange(item.value)
                    setOpen(false)
                  }}
                >
                  <strong>{item.label}</strong>
                </button>
              ))}
            </div>
          </div>
        </GuideLayer>
      )}
    </>
  )
}
