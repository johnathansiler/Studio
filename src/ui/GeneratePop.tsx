import { useEffect, useMemo, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import {
  GENERATOR_KINDS,
  GENERATOR_STYLES,
  contextFromScale,
  generate,
  type GeneratorKind,
  type GeneratorStyle,
  type GeneratedClip,
} from '../model/generate'
import { NOTE_NAMES, SCALES, type ScaleId } from '../model/scale'
import { quartersPerBar } from '../model/time'
import type { ProjectStore } from '../state/store'

export function GeneratePop({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const scaleState = store.scaleState()
  const [style, setStyle] = useState<GeneratorStyle>('pop')
  const [kind, setKind] = useState<GeneratorKind>('chords')
  const [seed, setSeed] = useState(1)
  const [placed, setPlaced] = useState('')
  const beatsPerBar = quartersPerBar(store.project.timeSignature)
  const scale = useMemo(() => contextFromScale(scaleState.root, scaleState.scale), [scaleState.root, scaleState.scale])
  const clip = useMemo(
    () => generate({ scale, style, kind, tempo: store.project.tempo, beatsPerBar, seed }),
    [scale, style, kind, store.project.tempo, beatsPerBar, seed],
  )
  useEffect(() => () => engine.stopPreview(), [engine])
  const chooseKind = (next: GeneratorKind) => {
    setPlaced('')
    if (next === kind) setSeed((value) => value + 1)
    else setKind(next)
  }
  const hear = () => {
    engine.unlock()
    engine.previewClip(clip.notes, store.project.tempo, clip.kind === 'drums')
  }
  const insert = () => {
    engine.stopPreview()
    const id = store.insertGenerated(clip)
    if (!id) return
    store.setView('arrange')
    setPlaced(clip.track)
  }
  return (
    <div className="gen-pop" data-generate="open" role="dialog" aria-label="Generate">
      <header>
        <strong>Generate</strong>
        <button type="button" className="text-btn" onClick={onClose} aria-label="Close generate">×</button>
        <select aria-label="Key" value={scaleState.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
          {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
        </select>
        <select aria-label="Scale" value={scaleState.scale} onChange={(event) => store.setScale({ scale: event.target.value as ScaleId })}>
          {SCALES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <span className="gen-tempo">{Math.round(store.project.tempo)} bpm</span>
      </header>
      <div className="chip-row" aria-label="Style">
        {GENERATOR_STYLES.map((item) => (
          <button key={item.id} type="button" className={style === item.id ? 'on' : ''} aria-pressed={style === item.id} onClick={() => { setStyle(item.id); setPlaced('') }}>{item.name}</button>
        ))}
      </div>
      <div className="chip-row" aria-label="Part">
        {GENERATOR_KINDS.map((item) => (
          <button key={item.id} type="button" className={kind === item.id ? 'on' : ''} aria-pressed={kind === item.id} onClick={() => chooseKind(item.id)}>{item.name}</button>
        ))}
      </div>
      <p className="gen-summary" aria-live="polite">{clip.name} · {clip.summary}</p>
      <Preview clip={clip} />
      <div className="gen-actions">
        <button type="button" onClick={hear}>Hear</button>
        <button type="button" onClick={() => { setSeed((value) => value + 1); setPlaced('') }}>Re-roll</button>
        <button type="button" className="insert" onClick={insert}>{placed ? `On ${placed}` : 'Insert'}</button>
      </div>
    </div>
  )
}

function Preview({ clip }: { clip: GeneratedClip }) {
  const total = Math.max(GRID_SAFE, clip.bars * clip.beatsPerBar)
  const pitches = clip.notes.map((note) => note.pitch)
  const low = Math.min(...pitches)
  const high = Math.max(...pitches)
  const span = Math.max(1, high - low)
  return (
    <div className={`gen-roll ${clip.kind === 'drums' ? 'drums' : ''}`} aria-hidden="true">
      {clip.notes.map((note, index) => (
        <i
          key={`${note.pitch}-${note.startBeat}-${index}`}
          style={{
            left: `${(note.startBeat / total) * 100}%`,
            width: `${Math.max(0.4, (note.durationBeats / total) * 100)}%`,
            bottom: `${((note.pitch - low) / span) * 88}%`,
            height: `${Math.max(6, 88 / (span + 1))}%`,
            opacity: 0.45 + note.velocity * 0.55,
          }}
        />
      ))}
    </div>
  )
}

const GRID_SAFE = 0.25
