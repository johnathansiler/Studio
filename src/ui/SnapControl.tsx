import { SNAP_DIVISIONS, normalizeSnapDivision, type SnapDivisionId } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'

/** One Snap control. On follows the grid. Off is free, small steps. */
export function SnapControl({ store }: { store: ProjectStore }) {
  const on = store.project.snap !== false
  const division = normalizeSnapDivision(store.project.snapDivision)
  return (
    <div className="snap-control" role="group" aria-label="Snap">
      <button
        type="button"
        className={`snap-toggle${on ? ' on' : ''}`}
        aria-pressed={on}
        title={on ? 'Snap is on. Edits land on the grid.' : 'Fine is on. Edits move in small steps, with no grid.'}
        onClick={() => store.toggle('snap')}
      >
        <strong>{on ? 'Snap' : 'Fine'}</strong>
        <small>{on ? 'On grid' : 'Free'}</small>
      </button>
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
    </div>
  )
}
