import { useEffect, useMemo, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { barsOf, generateEnsemble } from '../ideas/ensemble'
import { PART_GENRES } from '../ideas/genres'
import type { PartNote, PartRole } from '../ideas/types'
import type { GeneratorChord } from '../generators/types'
import { NOTE_NAMES } from '../model/scale'
import { quartersPerBar } from '../model/time'
import type { ProjectStore } from '../state/store'
import { SCALE_CHOICES } from '../unstuck/brief'

const ROLES: { id: PartRole; name: string }[] = [
  { id: 'chords', name: 'Chords' },
  { id: 'bass', name: 'Bass' },
  { id: 'melody', name: 'Melody' },
  { id: 'drums', name: 'Drums' },
]

const BARS = [4, 8, 16] as const

function genreForTempo(tempo: number) {
  if (tempo < 92) return 'lofi'
  if (tempo < 110) return 'boom-bap'
  if (tempo < 125) return 'pop'
  if (tempo < 136) return 'house'
  return 'trap'
}

export function PartsGenerator({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const project = store.project
  const scale = project.scale
  const [key, setKey] = useState(scale?.root ?? 0)
  const [scaleId, setScaleId] = useState(scale?.library || scale?.scale || 'ionian')
  const [tempo, setTempo] = useState(() => Math.round(project.tempo || 120))
  const [genre, setGenre] = useState(() => genreForTempo(project.tempo || 120))
  const [bars, setBars] = useState<4 | 8 | 16>(4)
  const [roles, setRoles] = useState<PartRole[]>(['chords', 'bass', 'melody', 'drums'])
  const [complexity, setComplexity] = useState(0.55)
  const [energy, setEnergy] = useState(0.72)
  const [swing, setSwing] = useState(0.15)
  const [seed, setSeed] = useState(1)
  const [salts, setSalts] = useState<Partial<Record<PartRole, number>>>({})
  const [locks, setLocks] = useState<Partial<Record<PartRole, PartNote[]>>>({})
  const [held, setHeld] = useState<GeneratorChord[] | null>(null)
  const choices = SCALE_CHOICES.some((item) => item.id === scaleId) ? SCALE_CHOICES : [{ id: scaleId, name: scaleId }, ...SCALE_CHOICES]
  const ensemble = useMemo(() => generateEnsemble({
    key,
    scaleId,
    tempo,
    genre,
    bars,
    roles,
    complexity,
    energy,
    swing,
    seed,
    beatsPerBar: Math.max(1, quartersPerBar(project.timeSignature)),
    salts,
    locked: locks,
    progression: locks.chords && held ? held : undefined,
  }), [key, scaleId, tempo, genre, bars, roles, complexity, energy, swing, seed, salts, locks, held, project.timeSignature])

  useEffect(() => () => engine.stopPreview(), [engine])

  function hear(which: PartRole[]) {
    engine.unlock()
    engine.stopPreview()
    const beat = 60 / Math.max(40, ensemble.tempo)
    const events = []
    for (const role of which) {
      const part = ensemble.parts.find((item) => item.role === role)
      if (!part) continue
      for (const note of part.notes) {
        events.push({
          pitch: note.pitch,
          at: note.startBeat * beat,
          dur: Math.max(0.05, note.durationBeats * beat),
          velocity: note.velocity,
          drum: role === 'drums',
          cents: note.fine ?? 0,
        })
      }
    }
    if (!events.length) {
      store.toast('Nothing to hear yet.', 'warn')
      return
    }
    engine.previewSequence(events.slice(0, 700))
  }

  function toggleRole(role: PartRole) {
    setRoles((current) => {
      if (current.includes(role)) {
        if (current.length === 1) {
          store.toast('Keep at least one part.', 'warn')
          return current
        }
        return current.filter((item) => item !== role)
      }
      return [...current, role]
    })
  }

  function toggleLock(role: PartRole) {
    const part = ensemble.parts.find((item) => item.role === role)
    if (!part) {
      store.toast('Turn that part on first.', 'warn')
      return
    }
    setLocks((current) => {
      if (current[role]) {
        const next = { ...current }
        delete next[role]
        return next
      }
      if (role === 'chords') setHeld(ensemble.chords)
      return { ...current, [role]: part.notes.map((note) => ({ ...note })) }
    })
  }

  function again(role: PartRole) {
    const name = ROLES.find((item) => item.id === role)?.name ?? role
    if (locks[role]) {
      store.toast(`${name} is locked. Unlock it to roll again.`, 'warn')
      return
    }
    if (!roles.includes(role)) {
      store.toast(`Turn ${name} on first.`, 'warn')
      return
    }
    setSalts((current) => ({ ...current, [role]: (current[role] ?? 0) + 1 }))
  }

  const symbols = ensemble.chords.map((chord) => chord.symbol).filter(Boolean).join(' · ')

  return (
    <div className="parts-gen" data-parts="open" aria-label="Generate parts">
      <div className="parts-key">
        <label>
          <span>Key</span>
          <select aria-label="Key" value={key} onChange={(event) => setKey(Number(event.target.value))}>
            {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
        </label>
        <label>
          <span>Scale</span>
          <select aria-label="Scale" value={scaleId} onChange={(event) => setScaleId(event.target.value)}>
            {choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>Tempo</span>
          <input
            aria-label="Tempo"
            type="number"
            min={40}
            max={240}
            value={tempo}
            onChange={(event) => setTempo(Math.max(40, Math.min(240, Math.round(Number(event.target.value) || tempo))))}
          />
        </label>
      </div>
      <div className="parts-genres" role="group" aria-label="Genre">
        {PART_GENRES.map((item) => (
          <button key={item.id} type="button" className={genre === item.id ? 'on' : ''} aria-pressed={genre === item.id} onClick={() => setGenre(item.id)}>
            {item.name}
          </button>
        ))}
      </div>
      <div className="parts-bars" role="group" aria-label="Bars">
        {BARS.map((value) => (
          <button key={value} type="button" className={bars === value ? 'on' : ''} aria-pressed={bars === value} onClick={() => setBars(barsOf(value))}>
            {value} bars
          </button>
        ))}
      </div>
      <div className="parts-roles" role="group" aria-label="Parts">
        {ROLES.map((role) => (
          <button key={role.id} type="button" className={roles.includes(role.id) ? 'on' : ''} aria-pressed={roles.includes(role.id)} onClick={() => toggleRole(role.id)}>
            {role.name}
          </button>
        ))}
      </div>
      <label className="parts-slide">
        <span>Complexity {complexity.toFixed(2)}</span>
        <input aria-label="Complexity" type="range" min={0} max={1} step={0.01} value={complexity} onChange={(event) => setComplexity(Number(event.target.value))} />
      </label>
      <label className="parts-slide">
        <span>Energy {energy.toFixed(2)}</span>
        <input aria-label="Energy" type="range" min={0} max={1} step={0.01} value={energy} onChange={(event) => setEnergy(Number(event.target.value))} />
      </label>
      <label className="parts-slide">
        <span>Swing {swing.toFixed(2)}</span>
        <input aria-label="Swing" type="range" min={0} max={1} step={0.01} value={swing} onChange={(event) => setSwing(Number(event.target.value))} />
      </label>
      <p className="parts-line">{symbols || 'A progression in this key.'} · seed {seed}</p>
      <div className="parts-commit">
        <button type="button" onClick={() => setSeed((current) => (current + 1 + Math.floor(Math.random() * 997)) >>> 0)}>New seed</button>
        <button type="button" onClick={() => hear(roles)}>Hear</button>
        <button type="button" className="on" onClick={() => { engine.stopPreview(); store.addEnsemble(ensemble, engine.currentTimelineSample()) }}>Add to project</button>
      </div>
      <div className="parts-list">
        {ROLES.map((role) => {
          const part = ensemble.parts.find((item) => item.role === role.id)
          const on = roles.includes(role.id)
          const locked = Boolean(locks[role.id])
          return (
            <div key={role.id} className="parts-row" data-part={role.id}>
              <div>
                <b>{role.name}</b>
                <span>{on ? `${part?.notes.length ?? 0} notes` : 'Off'}{locked ? ' · locked' : ''}</span>
              </div>
              <button type="button" onClick={() => hear([role.id])}>Hear</button>
              <button type="button" className={locked ? 'on' : ''} aria-pressed={locked} onClick={() => toggleLock(role.id)}>{locked ? 'Locked' : 'Lock'}</button>
              <button type="button" onClick={() => again(role.id)}>Again</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
