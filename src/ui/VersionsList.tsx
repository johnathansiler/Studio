import { useEffect, useState } from 'react'
import type { Project } from '../model/types'
import { listVersions, loadVersion } from '../storage/idb'
import { versionWhen, type VersionListItem } from '../state/versions'

export function VersionsList({
  projectId,
  tick,
  onSave,
  onRestore,
}: {
  projectId: string
  tick: number
  onSave: () => void
  onRestore: (project: Project) => void
}) {
  const [rows, setRows] = useState<VersionListItem[]>([])
  useEffect(() => {
    let cancel = false
    void listVersions(projectId)
      .then((items) => {
        if (!cancel) setRows(items)
      })
      .catch(() => {
        if (!cancel) setRows([])
      })
    return () => {
      cancel = true
    }
  }, [projectId, tick])

  return (
    <div className="version-panel" aria-label="Versions">
      <button type="button" className="text-btn" onClick={onSave}>
        Save version
      </button>
      {rows.length === 0 && <p className="version-empty">No versions yet.</p>}
      {rows.map((item) => (
        <div className="version-row" key={item.id}>
          <strong>{item.name}</strong>
          <span>
            {item.by} · {versionWhen(item.at)}
          </span>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              void loadVersion(item.id).then((doc) => {
                if (doc?.project) onRestore(doc.project)
              })
            }}
          >
            Restore for everyone
          </button>
        </div>
      ))}
    </div>
  )
}
