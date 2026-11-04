import { useState } from 'react'
import { SNAP_DIVISIONS, normalizeSnapDivision, type SnapDivisionId } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { BevelSelect } from './BevelSelect'
import { useFormFactor } from './form'

/** One Snap control. On follows the grid. Off is free, small steps. */
export function SnapControl({ store, inline = false }: { store: ProjectStore; inline?: boolean }) {
  const on = store.project.snap !== false
  const division = normalizeSnapDivision(store.project.snapDivision)
  const gridLabel = SNAP_DIVISIONS.find((item) => item.id === division)?.label ?? division
  const form = useFormFactor()
  const options = SNAP_DIVISIONS.map((item) => ({ value: item.id, label: item.label }))
  const [open, setOpen] = useState(false)
  if (inline) {
    const snapHint = on
      ? 'Snap is on. Edits land on the grid. Open this to change the grid or turn snap off.'
      : 'Snap is off. Edits move in small steps. Open this to land on the grid.'
    return (
      <div className="snap-control inline" role="group" aria-label="Snap">
        <button
          type="button"
          className={`snap-toggle snap-inline${on ? ' on' : ''}`}
          aria-pressed={on}
          aria-expanded={open}
          aria-controls="snap-choices"
          title={snapHint}
          aria-label={`Snap ${on ? gridLabel : 'Off'}. ${snapHint}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tool-label">Snap {on ? gridLabel : 'Off'}</span>
        </button>
        {open && (
          <div id="snap-choices" className="inline-choices snap-choices" role="group" aria-label="Snap settings">
            <button
              type="button"
              className={on ? 'on' : ''}
              aria-pressed={on}
              title={on ? 'Snap is on. Press to move in small steps.' : 'Snap is off. Press to land on the grid.'}
              onClick={() => store.toggle('snap')}
            >
              {on ? 'Snap On' : 'Snap Off'}
            </button>
            {SNAP_DIVISIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={on && item.id === division ? 'on' : ''}
                aria-pressed={on && item.id === division}
                title={`Grid size ${item.label}. Used when Snap is on.`}
                onClick={() => {
                  store.setSnapDivision(item.id)
                  if (store.project.snap === false) store.toggle('snap')
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="snap-control" role="group" aria-label="Snap">
      <button
        type="button"
        className={`snap-toggle${on ? ' on' : ''}`}
        aria-pressed={on}
        title={on ? 'Snap is on. Edits land on the grid. Press to move in small steps.' : 'Snap is off. Edits move in small steps. Press to land on the grid.'}
        onClick={() => store.toggle('snap')}
      >
        <strong>Snap</strong>
        <small>{on ? 'On' : 'Fine'}</small>
      </button>
      {form === 'desk' ? (
        <label className="snap-grid">
          <strong>{gridLabel}</strong>
          <small>Grid</small>
          <select
            aria-label="Snap grid"
            title="Grid size used when Snap is on."
            value={division}
            onChange={(event) => store.setSnapDivision(event.target.value as SnapDivisionId)}
          >
            {SNAP_DIVISIONS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
      ) : (
        <BevelSelect
          className="snap-grid"
          label="Snap grid"
          hint="Grid size used when Snap is on."
          value={division}
          options={options}
          onChange={(next) => store.setSnapDivision(next as SnapDivisionId)}
        >
          <strong>{gridLabel}</strong>
          <small>Grid</small>
        </BevelSelect>
      )}
    </div>
  )
}
