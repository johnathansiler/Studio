import type { ProjectListItem } from '../storage/idb'
import { ageLabel } from './share'
import { peakOutline } from './waveformDraw'
import { MiniWave } from './WaveformView'

export function ProjectSheet({
  projects,
  snapshots,
  usage,
  persisted,
  name,
  onName,
  onClose,
  onNew,
  onSave,
  onSaveAs,
  onRename,
  onDuplicate,
  onDelete,
  onOpen,
  onRevert,
  onAudio,
  onKeep,
}: {
  projects: ProjectListItem[]
  snapshots: { key: string; savedAt: number }[]
  usage: string
  persisted: boolean
  name: string
  onName: (name: string) => void
  onClose: () => void
  onNew: () => void
  onSave: () => void
  onSaveAs: () => void
  onRename: () => void
  onDuplicate: () => void
  onDelete: (id: string) => void
  onOpen: (id: string) => void
  onRevert: (key: string) => void
  onAudio: () => void
  onKeep: () => void
}) {
  return (
    <div className="modal-back" data-screen-overlay="" role="dialog" aria-label="Projects" onClick={onClose}>
      <div className="modal" id="project-sheet" onClick={(event) => event.stopPropagation()}>
        <h2>Projects</h2>
        <input aria-label="Name" value={name} onChange={(event) => onName(event.target.value)} />
        <div className="row-btns wrap">
          <button className="text-btn" onClick={onNew}>New</button>
          <button className="text-btn" onClick={onSave}>Save</button>
          <button className="text-btn" onClick={onSaveAs}>Save As</button>
          <button className="text-btn" onClick={onRename}>Rename</button>
          <button className="text-btn" onClick={onDuplicate}>Duplicate</button>
          <button className="text-btn" onClick={onAudio}>Audio</button>
        </div>
        <div className="project-list">
          {projects.map((item) => (
            <div className="project-row" key={item.id}>
              <button className="text-btn project-open" onClick={() => onOpen(item.id)}>
                <span className="project-wave">
                  <MiniWave outline={peakOutline(item.peaks)} color="#73c48f" label={`${item.name} waveform`} />
                </span>
                <span>{item.name}</span>
                <span>{ageLabel(item.savedAt)}</span>
              </button>
              <button className="text-btn" aria-label={`Delete ${item.name}`} onClick={() => onDelete(item.id)}>Delete</button>
            </div>
          ))}
        </div>
        {snapshots.length > 0 && (
          <div className="project-list">
            {snapshots.map((item) => (
              <button key={item.key} className="text-btn" onClick={() => onRevert(item.key)}>
                Revert {ageLabel(item.savedAt)}
              </button>
            ))}
          </div>
        )}
        <div className="row-btns">
          <span>{usage}</span>
          {!persisted && <button className="text-btn" onClick={onKeep}>Keep</button>}
          <button className="text-btn overlay-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

