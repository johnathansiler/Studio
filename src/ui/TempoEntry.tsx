import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { TEMPO_MAX, TEMPO_MIN } from '../model/tap'
import { placeTempoEntry } from '../model/tempoEntry'

/** Small BPM field anchored under Tap Tempo. Not a sheet. */
export function TempoEntry({
  anchorRef,
  value,
  error,
  disabled,
  inputRef,
  onChange,
  onApply,
  onDismiss,
  onBump,
}: {
  anchorRef: RefObject<HTMLElement | null>
  value: string
  error: string | null
  disabled?: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onApply: (value: string) => void
  onDismiss: () => void
  onBump: (delta: number) => void
}) {
  const rootRef = useRef<HTMLFormElement>(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useLayoutEffect(() => {
    const node = rootRef.current
    const trigger = anchorRef.current
    if (!node || !trigger) return
    const fit = () => {
      const rect = trigger.getBoundingClientRect()
      const next = placeTempoEntry(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        { width: node.offsetWidth, height: node.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      )
      node.style.top = `${next.top}px`
      node.style.left = `${next.left}px`
      node.style.visibility = 'visible'
    }
    fit()
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
      window.visualViewport?.removeEventListener('resize', fit)
    }
  }, [anchorRef, error])

  useLayoutEffect(() => {
    const node = inputRef.current
    node?.focus()
    node?.select()
  }, [inputRef])

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      dismissRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismissRef.current()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef])

  const apply = (text: string) => onApply(text)

  return createPortal(
    <form
      ref={rootRef}
      className="tempo-entry"
      role="dialog"
      aria-label="Tempo"
      data-tempo-entry=""
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        apply(inputRef.current?.value ?? value)
      }}
    >
      <span className="tempo-entry-kicker">BPM</span>
      <input
        ref={inputRef}
        className="tempo-entry-input"
        type="number"
        inputMode="decimal"
        enterKeyHint="done"
        autoFocus
        autoComplete="off"
        min={TEMPO_MIN}
        max={TEMPO_MAX}
        step={0.1}
        disabled={disabled}
        aria-label="Tempo. Type an exact tempo."
        aria-invalid={error ? true : undefined}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Done') {
            event.preventDefault()
            event.stopPropagation()
            apply(event.currentTarget.value)
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onDismiss()
            return
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          const delta = (event.shiftKey ? 1 : 0.1) * (event.key === 'ArrowUp' ? 1 : -1)
          onBump(delta)
        }}
        onPointerDown={(event: ReactPointerEvent<HTMLInputElement>) => event.stopPropagation()}
      />
      {error ? <p className="tempo-entry-error" role="alert">{error}</p> : null}
      <div className="tempo-entry-actions">
        <button type="button" onClick={onDismiss}>Cancel</button>
        <button type="button" className="ok" onClick={() => apply(inputRef.current?.value ?? value)}>OK</button>
      </div>
    </form>,
    document.body,
  )
}
