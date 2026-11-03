import type { AssetStatus } from '../remote/assets'

/** One row per shared take or clip that is moving between peers. */
export function AssetTransfers({ rows }: { rows: AssetStatus[] }) {
  if (!rows.length) return null
  return (
    <div className="asset-transfers" aria-label="Shared audio">
      {rows.map((row) => (
        <div
          key={row.id}
          className="asset-transfer ch-raised"
          data-asset={row.id}
          role="status"
          aria-label={`${row.name}. ${row.label}`}
        >
          <span className="asset-transfer-name">{row.name}</span>
          <span className="asset-transfer-state">{row.label}</span>
          <span className="asset-transfer-bar" aria-hidden="true">
            <i style={{ width: `${Math.round(Math.min(1, Math.max(0, row.progress)) * 100)}%` }} />
          </span>
        </div>
      ))}
    </div>
  )
}
