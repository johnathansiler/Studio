import { useState } from 'react'
import { gainForDb, dbFromGain } from '../model/mixLaw'
import { gainToDb } from '../model/time'

/** Visible decibel text plus a number field on the same spot, so a value can be typed. */
export function DbRead({
  gain,
  min,
  max,
  label,
  onChange,
  onFocus,
  onBlur,
}: {
  gain: number
  min: number
  max: number
  label: string
  onChange: (gain: number) => void
  onFocus?: () => void
  onBlur?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = gain > 0.0001 ? (Math.round(dbFromGain(gain) * 10) / 10).toFixed(1) : ''
  const text = gainToDb(gain)
  return (
    <span className="fader-db">
      <span aria-hidden="true">{text}</span>
      <input
        className="db-type"
        type="number"
        inputMode="decimal"
        step={0.1}
        min={-60}
        max={12}
        aria-label={label}
        title="Type a level in decibels. 0 is unity."
        value={draft ?? shown}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onFocus={(event) => {
          setDraft(event.currentTarget.value)
          onFocus?.()
        }}
        onBlur={() => {
          setDraft(null)
          onBlur?.()
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          const db = Number(event.target.value)
          if (!Number.isFinite(db)) return
          onChange(gainForDb(db, min, max))
        }}
      />
    </span>
  )
}
