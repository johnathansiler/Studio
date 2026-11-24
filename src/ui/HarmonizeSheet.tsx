import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NOTE_NAMES } from '../model/scale'
import { projectMusicalKey } from '../model/keyFit'
import {
  defaultHarmonizeKey,
  harmonizeMoves,
  majorMinorKey,
  nothingToHarmonizeMessage,
  planRows,
  semitoneLabel,
  shiftableCount,
  type HarmonizeRow,
  type ScopedClip,
} from '../model/harmonize'
import type { ProjectStore } from '../state/store'
import { SheetGrab } from './bottomSheet'
import { SheetHeader } from './SheetClose'
import { collectHarmonizeInputs, detectMissingKeys, pitchHarmonizeMoves, scopeSession } from './harmonizeSong'
import './harmonize.css'

/**
 * Asks which key to use, then shifts every ticked harmonic clip.
 * Vocal tracks stay listed and skipped until Include vocals is on.
 */
export function HarmonizeSheet({ store }: { store: ProjectStore }) {
  const alive = useRef(true)
  const [scoped, setScoped] = useState<ScopedClip[] | null>(null)
  const [root, setRoot] = useState(0)
  const [minor, setMinor] = useState(false)
  const [includeVocals, setIncludeVocals] = useState(false)
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set())
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>({ done: 0, total: 1, label: 'Checking clips' })
  const [applying, setApplying] = useState(false)
  const host = useMemo(() => sheetHost(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') store.closeHarmonize()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  useEffect(() => {
    alive.current = true
    let cancel = false
    const still = () => alive.current && !cancel
    void (async () => {
      const inputs = collectHarmonizeInputs(store)
      let clips = scopeSession(inputs)
      const needs = clips.some((clip) => clip.needsDetect)
      if (needs) {
        clips = await detectMissingKeys(store, clips, (done, total, label) => {
          if (still()) setProgress({ done, total: Math.max(1, total), label })
        }, still)
      }
      if (!still()) return
      const song = projectMusicalKey(store.scaleState())
      const target = defaultHarmonizeKey(song, clips)
      const preview = target ? planRows(clips, target, true) : []
      if (!target || shiftableCount(preview) === 0) {
        store.toast(nothingToHarmonizeMessage(preview.length ? preview : planRows(clips, majorMinorKey(0, false), true)))
        store.closeHarmonize()
        return
      }
      setRoot(target.root)
      setMinor(target.minor)
      setScoped(clips)
      setProgress(null)
    })()
    return () => {
      cancel = true
      alive.current = false
    }
  }, [store])

  const target = majorMinorKey(root, minor)
  const rows = scoped ? planRows(scoped, target, includeVocals) : []
  const shifts = rows.filter((row) => row.action === 'shift')
  const skips = rows.filter((row) => row.action === 'skip')
  const chosen = shifts.filter((row) => !unticked.has(row.clipId))

  async function apply() {
    if (!scoped || applying) return
    const moves = harmonizeMoves(rows, unticked)
    if (!chosen.length) {
      store.toast('Pick at least one clip to shift.')
      return
    }
    setApplying(true)
    setProgress({ done: 0, total: Math.max(1, moves.length), label: 'Shifting' })
    await pitchHarmonizeMoves(store, moves, (done, total, label) => {
      if (alive.current) setProgress({ done, total: Math.max(1, total), label })
    }, () => alive.current)
    if (!alive.current) return
    store.applyHarmonize({ root, minor, moves })
    const count = chosen.length
    store.toast(count === 1 ? `Harmonized 1 clip to ${target.label}.` : `Harmonized ${count} clips to ${target.label}.`)
  }

  const sheet = (
    <section
      id="harmonize-song"
      className="bottom-sheet arrange-sheet"
      data-bottom-sheet="open"
      data-arrange-sheet="harmonize-song"
      data-harmonize-sheet=""
      role="dialog"
      aria-label="Harmonize song"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <SheetGrab label="Resize Harmonize song. Drag up or down." />
      <SheetHeader
        className="arrange-sheet-head"
        title={<strong>Harmonize song</strong>}
        detail={<span>Pick the key. Untick anything that should stay.</span>}
        onClose={() => store.closeHarmonize()}
      />
      <div className="bottom-sheet-body harmonize-sheet">
        <label className="harmonize-key">
          <span>Key</span>
          <select aria-label="Key" value={root} disabled={!scoped || applying} onChange={(event) => setRoot(Number(event.target.value))}>
            {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
        </label>
        <div className="harmonize-mode" role="group" aria-label="Major or minor">
          <button type="button" aria-pressed={!minor} disabled={!scoped || applying} onClick={() => setMinor(false)}>Major</button>
          <button type="button" aria-pressed={minor} disabled={!scoped || applying} onClick={() => setMinor(true)}>Minor</button>
        </div>
        <button
          type="button"
          className="harmonize-vocals"
          data-include-vocals=""
          aria-pressed={includeVocals}
          disabled={!scoped || applying}
          title="Vocal tracks are recorded as sung. Turn this on to pitch them too."
          onClick={() => setIncludeVocals((value) => !value)}
        >
          <span>Include vocals</span>
          <span>{includeVocals ? 'On' : 'Off'}</span>
        </button>
        {progress ? <Progress done={progress.done} total={progress.total} label={progress.label} /> : null}
        {scoped ? (
          <>
            <section className="harmonize-list" aria-label="Clips that will shift">
              <h3>{`Will shift (${chosen.length})`}</h3>
              {shifts.length === 0 ? <p className="harmonize-empty">Nothing in this key is waiting. Include vocals, or pick another key.</p> : null}
              <ul>
                {shifts.map((row) => (
                  <li key={`${row.trackId}:${row.clipId}`}>
                    <label>
                      <input
                        type="checkbox"
                        data-harmonize-clip={row.clipId}
                        checked={!unticked.has(row.clipId)}
                        disabled={applying}
                        onChange={() => toggle(row.clipId, unticked, setUnticked)}
                      />
                      <span>
                        <strong>{row.name}</strong>
                        <small>{shiftLine(row)}</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
            {skips.length ? (
              <section className="harmonize-list harmonize-skips" aria-label="Clips that stay put">
                <h3>Stays put</h3>
                <ul>
                  {skips.map((row) => (
                    <li key={`${row.trackId}:${row.clipId}`}>
                      <span>
                        <strong>{row.name}</strong>
                        <small>{row.reason}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="harmonize-foot">
        <button type="button" className="harmonize-apply" data-harmonize-apply="" disabled={!scoped || applying} onClick={() => { void apply() }}>
          {applying ? 'Shifting…' : `Harmonize to ${target.label}`}
        </button>
      </div>
    </section>
  )
  return host ? createPortal(sheet, host) : sheet
}

function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const value = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div
      className="harmonize-progress"
      data-harmonize-progress=""
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={label}
    >
      <span>{label}</span>
      <i style={{ width: `${value}%` }} />
    </div>
  )
}

function shiftLine(row: HarmonizeRow) {
  const semis = row.semitones ?? 0
  const move = semis === 0 ? 'already there' : semitoneLabel(semis)
  return `${row.from} → ${row.to}, ${move}`
}

function toggle(id: string, unticked: Set<string>, setUnticked: (next: Set<string>) => void) {
  const next = new Set(unticked)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  setUnticked(next)
}

function sheetHost() {
  if (typeof document === 'undefined') return null
  return document.querySelector('.arrange-stage') || document.getElementById('phone-sheet-host') || document.body
}
