import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { KEY_TONICS } from '../library/musicalKey'
import {
  defaultHarmonizeKey,
  formatHarmonizeSemitones,
  musicalKey,
  retargetHarmonize,
  type HarmonizeRow,
} from '../model/harmonize'
import type { MusicalKey } from '../model/keyFit'
import type { ProjectStore } from '../state/store'
import { SheetGrab } from './bottomSheet'
import { askHarmonize, resolveHarmonizeRows, runHarmonizeSong, type HarmonizeProgress } from './harmonizeSong'
import { SheetHeader } from './SheetClose'
import './harmonize.css'

export function HarmonizeButton({
  store,
  place,
  className,
  children = 'Harmonize',
  onOpened,
}: {
  store: ProjectStore
  place: 'tools' | 'transport' | 'dock'
  className?: string
  children?: ReactNode
  /** Runs after the picker opens. A toast for an empty song does not call this. */
  onOpened?: () => void
}) {
  return (
    <button
      type="button"
      className={className ?? 'harmonize-song'}
      data-harmonize-song={place}
      aria-label="Harmonize song"
      title="Shift every melodic loop and instrument clip into one key. Drums, one-shots, and SFX stay put. Vocals stay as sung unless you include them."
      onClick={() => {
        if (askHarmonize(store)) onOpened?.()
      }}
    >
      {children}
    </button>
  )
}

function harmonizeSnapshot(store: ProjectStore) {
  const scale = store.scaleState()
  return `${store.harmonizeOpen ? 1 : 0}|${scale.root}|${scale.scale}|${scale.keySet ? 1 : 0}`
}

export function HarmonizeSheet({ store }: { store: ProjectStore }) {
  const snap = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => harmonizeSnapshot(store),
    () => harmonizeSnapshot(store),
  )
  const [openFlag, rootText, scaleId, keyFlag] = snap.split('|')
  const open = openFlag === '1'
  const scale = { root: Number(rootText), scale: scaleId, keySet: keyFlag === '1' }
  const [includeVocals, setIncludeVocals] = useState(false)
  const [picked, setPicked] = useState<MusicalKey | null>(null)
  const [rows, setRows] = useState<HarmonizeRow[]>([])
  const [phase, setPhase] = useState<'listen' | 'ready' | 'shift'>('listen')
  const [progress, setProgress] = useState<HarmonizeProgress | null>(null)

  useEffect(() => {
    if (open) return
    setIncludeVocals(false)
    setPicked(null)
    setRows([])
    setPhase('listen')
    setProgress(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') store.closeHarmonizeSheet()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, store])

  useEffect(() => {
    if (!open) return
    let alive = true
    setRows([])
    setPhase('listen')
    setProgress({ phase: 'listen', done: 0, total: 0, name: '' })
    void resolveHarmonizeRows(store, {
      includeVocals,
      onProgress: (next) => {
        if (alive) setProgress(next)
      },
    }).then((next) => {
      if (!alive) return
      setRows(next)
      setPhase('ready')
      setProgress(null)
    })
    return () => {
      alive = false
    }
  }, [open, includeVocals, store])

  if (!open) return null
  const shifts = rows.filter((row) => row.action === 'shift')
  const target = picked ?? defaultHarmonizeKey(scale, shifts)
  const shown = retargetHarmonize(rows, target)
  return (
    <HarmonizeDialog
      rows={shown}
      target={target}
      includeVocals={includeVocals}
      phase={phase}
      progress={progress}
      onNote={(root) => setPicked(musicalKey(root, target.minor))}
      onMode={(minor) => setPicked(musicalKey(target.root, minor))}
      onVocals={setIncludeVocals}
      onClose={() => store.closeHarmonizeSheet()}
      onApply={() => {
        if (phase === 'listen') {
          store.toast('Still listening for keys.', 'info')
          return
        }
        if (phase === 'shift') {
          store.toast('Still shifting clips.', 'info')
          return
        }
        setPhase('shift')
        void runHarmonizeSong(store, rows, target, setProgress)
          .then((ok) => {
            if (ok) store.closeHarmonizeSheet()
            else setPhase('ready')
          })
          .catch(() => {
            store.toast('Could not harmonize the song.', 'warn')
            setPhase('ready')
          })
      }}
    />
  )
}

export function HarmonizeDialog({
  rows,
  target,
  includeVocals,
  phase,
  progress,
  onNote,
  onMode,
  onVocals,
  onApply,
  onClose,
}: {
  rows: HarmonizeRow[]
  target: MusicalKey
  includeVocals: boolean
  phase: 'listen' | 'ready' | 'shift'
  progress: HarmonizeProgress | null
  onNote: (root: number) => void
  onMode: (minor: boolean) => void
  onVocals: (include: boolean) => void
  onApply: () => void
  onClose: () => void
}) {
  const shifts = rows.filter((row) => row.action === 'shift')
  const skips = rows.filter((row) => row.action === 'skip')
  const listening = rows.filter((row) => row.action === 'listen')
  const busy = phase !== 'ready'
  const progressLabel = progress && progress.total
    ? `${progress.phase === 'listen' ? 'Listening' : 'Shifting'} ${progress.done} of ${progress.total}${progress.name ? `: ${progress.name}` : ''}`
    : phase === 'listen'
      ? 'Checking keys…'
      : 'Shifting…'
  return (
    <section
      className="bottom-sheet arrange-sheet harmonize-sheet"
      data-harmonize-sheet="open"
      data-bottom-sheet="open"
      role="dialog"
      aria-label="Harmonize song"
      aria-busy={busy}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <SheetGrab label="Resize Harmonize song. Drag up or down." />
      <SheetHeader
        title={<strong>Harmonize song</strong>}
        detail={<span className="harmonize-detail">Pick one key. Melodic clips move. Drums stay.</span>}
        onClose={onClose}
      />
      <div className="bottom-sheet-body harmonize-body">
        <div className="harmonize-notes" role="group" aria-label="Key">
          {KEY_TONICS.map((name, root) => (
            <button
              key={name}
              type="button"
              data-harmonize-note={name}
              aria-pressed={target.root === root}
              aria-label={`${name} ${target.minor ? 'minor' : 'major'}`}
              onClick={() => onNote(root)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="harmonize-modes" role="group" aria-label="Major or minor">
          <button type="button" data-harmonize-mode="major" aria-pressed={!target.minor} onClick={() => onMode(false)}>Major</button>
          <button type="button" data-harmonize-mode="minor" aria-pressed={target.minor} onClick={() => onMode(true)}>Minor</button>
        </div>
        <label className="harmonize-vocals" title="Vocal tracks are recorded as sung. Leave this off unless those takes should be pitched too.">
          <input
            type="checkbox"
            data-include-vocals=""
            checked={includeVocals}
            onChange={(event) => onVocals(event.target.checked)}
          />
          <span>Include vocals <small>Recorded vocals stay as sung.</small></span>
        </label>
        <p className="harmonize-note">Smallest move, −6 to +5. A minor into C major does not move.</p>
        {busy && (
          <div
            className="harmonize-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={Math.max(1, progress?.total || 1)}
            aria-valuenow={progress?.done || 0}
            aria-valuetext={progressLabel}
            data-harmonize-progress=""
          >
            <i style={{ width: `${progress?.total ? Math.round((progress.done / progress.total) * 100) : 8}%` }} />
            <span>{progressLabel}</span>
          </div>
        )}
        <div className="harmonize-list">
          <h3>Will shift</h3>
          {shifts.length === 0 && listening.length === 0 ? <p className="harmonize-empty">Nothing melodic to move.</p> : null}
          <ul>
            {shifts.map((row) => (
              <li key={row.clipId} data-harmonize-row="shift">
                <span>{row.name}</span>
                <span>{`${row.from} → ${row.to}`}</span>
                <span>{formatHarmonizeSemitones(row.semitones)}</span>
              </li>
            ))}
            {listening.map((row) => (
              <li key={row.clipId} data-harmonize-row="listen">
                <span>{row.name}</span>
                <span>Listening…</span>
              </li>
            ))}
          </ul>
          <h3>Stays put</h3>
          {skips.length === 0 ? <p className="harmonize-empty">Nothing held back.</p> : null}
          <ul>
            {skips.map((row) => (
              <li key={row.clipId} data-harmonize-row="skip">
                <span>{row.name}</span>
                <span>{row.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="harmonize-foot">
        <button type="button" data-harmonize-apply="" onClick={onApply}>
          {phase === 'shift' ? 'Shifting…' : `Harmonize to ${target.label}`}
        </button>
      </div>
    </section>
  )
}
