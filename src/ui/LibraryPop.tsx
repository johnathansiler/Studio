import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { NOTE_NAMES } from '../model/scale'
import type { ProjectStore } from '../state/store'
import {
  allScales,
  chordsInScale,
  getScale,
  harmonize,
  isBuiltinScale,
  loadScaleCatalog,
  nearestBuiltin,
  progressionsFor,
  realizeProgression,
  scaleFamilies,
  spellScale,
  suggestKey,
  toneFromCents,
  toneName,
  voiceTones,
  VOICINGS,
  withBass,
  type ChordGroup,
  type DiatonicChord,
  type KeySuggestion,
  type RealizedChord,
  type Tone,
  type VoicingId,
} from '../theory'

type GroupId = 'triad' | 'seventh' | 'ninth' | 'eleventh' | 'thirteenth' | 'sus' | 'add' | 'altered' | 'quartal' | 'cluster'

const GROUPS: { id: GroupId; name: string; description: string; size?: 3 | 4 | 5 | 6 | 7; chord?: ChordGroup }[] = [
  { id: 'triad', name: 'Triads', description: 'Three-note chords stacked in thirds on each scale degree.', size: 3 },
  { id: 'seventh', name: '7ths', description: 'Four-note chords. The seventh separates major from dominant.', size: 4 },
  { id: 'ninth', name: '9ths', description: 'Sevenths plus the ninth.', size: 5 },
  { id: 'eleventh', name: '11ths', description: 'Ninths plus the eleventh.', size: 6 },
  { id: 'thirteenth', name: '13ths', description: 'The full stack, up to the thirteenth.', size: 7 },
  { id: 'sus', name: 'Sus', description: 'Suspended chords whose notes fit this scale.', chord: 'sus' },
  { id: 'add', name: 'Add', description: 'Added tones on a triad, with no seventh.', chord: 'add' },
  { id: 'altered', name: 'Altered', description: 'Flat and sharp fifths and ninths that still fit the scale.', chord: 'altered' },
  { id: 'quartal', name: 'Quartal', description: 'Chords stacked in fourths.', chord: 'quartal' },
  { id: 'cluster', name: 'Clusters', description: 'Tight stacks of neighboring notes.', chord: 'cluster' },
]

export function LibraryPop({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const scale = store.scaleState()
  const [catalogTick, setCatalogTick] = useState(0)
  const [family, setFamily] = useState('all')
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<GroupId>('triad')
  const [bass, setBass] = useState<number | null>(null)
  const [hint, setHint] = useState('Pick a key and a scale. The chords inside it are listed below.')
  const [suggestion, setSuggestion] = useState<KeySuggestion | null>(null)
  const timers = useRef<number[]>([])
  const activeId = scale.library || scale.scale
  const active = getScale(activeId)

  useEffect(() => {
    let alive = true
    void loadScaleCatalog().then(() => {
      if (alive) setCatalogTick((value) => value + 1)
    })
    return () => {
      alive = false
      for (const timer of timers.current) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const notes = trackNotes(store)
    if (notes.length < 3) {
      setSuggestion(null)
      return
    }
    const found = suggestKey(notes)
    const same = found.root === scale.root && (found.library ? found.library === scale.library : !scale.library && found.scale === scale.scale)
    setSuggestion(same ? null : found)
  }, [catalogTick, scale.root, scale.scale, scale.library, store])

  const scales = useMemo(() => {
    const text = query.trim().toLowerCase()
    return allScales().filter((item) => {
      if (family !== 'all' && item.family !== family) return false
      if (!text) return true
      return `${item.name} ${item.description} ${item.family}`.toLowerCase().includes(text)
    })
  }, [catalogTick, family, query])

  const groupInfo = GROUPS.find((item) => item.id === group) ?? GROUPS[0]
  const chords = useMemo(() => {
    if (groupInfo.size) return harmonize(scale.root, activeId, groupInfo.size).map((chord) => ({ ...chord, fit: 1 }))
    return chordsInScale(scale.root, activeId, groupInfo.chord ? [groupInfo.chord] : undefined).slice(0, 48)
  }, [catalogTick, scale.root, activeId, groupInfo])
  const degrees = spellScale(scale.root, activeId, 3)
  const lines = useMemo(() => {
    const bar = Math.max(1, store.project.timeSignature?.numerator || 4)
    return progressionsFor(activeId).map((pattern) => ({
      pattern,
      chords: realizeProgression(scale.root, activeId, pattern, bar, groupInfo.size === 4 ? 4 : 3),
    }))
  }, [catalogTick, scale.root, activeId, groupInfo.size, store.project.timeSignature?.numerator])

  function describe(text: string) {
    return {
      title: text,
      onFocus: () => setHint(text),
      onPointerEnter: () => setHint(text),
      onPointerDown: () => setHint(text),
    }
  }

  function choose(id: string) {
    if (isBuiltinScale(id)) store.setScale({ scale: id, library: '' })
    else store.setScale({ scale: nearestBuiltin(getScale(id).cents), library: id })
    setBass(null)
    setHint(getScale(id).description)
  }

  function applySuggestion(found: KeySuggestion) {
    store.setScale({ root: found.root, scale: found.scale, library: found.library, snap: true })
    setHint(`${found.name} is locked. New notes on the piano roll and pads stay inside it.`)
  }

  function shape(tones: Tone[], previous?: Tone[]) {
    const now = store.scaleState()
    const prev = previous ?? now.lastVoicing.map((midi, index) => ({ midi, cents: now.lastCents[index] ?? 0 }))
    const bassTone = bass == null ? null : degrees[bass] ?? null
    const base = bassTone ? placeBass(tones, bassTone) : tones
    return voiceTones(base, {
      inversion: now.inversion,
      voicing: now.voicing,
      voiceLead: now.voiceLead && prev.length > 0,
      previous: prev,
    })
  }

  function label(symbol: string, tones: Tone[]) {
    if (bass == null) return symbol
    const bassTone = degrees[bass]
    if (!bassTone) return symbol
    const root = tones[0]
    if (root && root.midi % 12 === bassTone.midi % 12 && root.cents === bassTone.cents) return symbol
    return `${symbol}/${toneName(bassTone)}`
  }

  function hear(tones: Tone[]) {
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
    engine.unlock()
    engine.previewPitches(tones.map((tone) => tone.midi + tone.cents / 100))
  }

  function putChord(chord: DiatonicChord) {
    const tones = shape(chord.tones)
    const bar = Math.max(1, store.project.timeSignature?.numerator || 4)
    hear(tones)
    store.insertLibrary(tones.map((tone) => ({ midi: tone.midi, cents: tone.cents, start: 0, duration: bar })), label(chord.symbol, chord.tones))
  }

  function putLine(chords: RealizedChord[], name: string) {
    let previous: Tone[] = store.scaleState().lastVoicing.map((midi, index) => ({ midi, cents: store.scaleState().lastCents[index] ?? 0 }))
    const events: { midi: number; cents: number; start: number; duration: number }[] = []
    const played: { tones: Tone[]; at: number }[] = []
    let beat = 0
    for (const chord of chords) {
      const tones = shape(chord.tones, previous)
      previous = tones
      played.push({ tones, at: beat })
      for (const tone of tones) events.push({ midi: tone.midi, cents: tone.cents, start: beat, duration: chord.beats })
      beat += chord.beats
    }
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
    engine.unlock()
    const beatMs = 60000 / Math.max(40, store.project.tempo)
    for (const chord of played) {
      const timer = window.setTimeout(() => engine.previewPitches(chord.tones.map((tone) => tone.midi + tone.cents / 100)), chord.at * beatMs)
      timers.current.push(timer)
    }
    store.insertLibrary(events, name)
  }

  return (
    <div className="ideas-pop library-pop" role="dialog" aria-label="Scale library">
      <header>
        <strong>Scales</strong>
        <button type="button" {...describe('Guess a key and scale from the MIDI already on this track.')} onClick={() => {
          const notes = trackNotes(store)
          if (notes.length < 3) {
            setHint('Play or draw a few notes first. Detect reads the MIDI on this track.')
            return
          }
          applySuggestion(suggestKey(notes))
        }}>Detect</button>
        <button
          type="button"
          className={scale.snap ? 'on' : ''}
          aria-pressed={scale.snap}
          {...describe('Lock the piano roll and pads to this scale, including quarter-tone pitches.')}
          onClick={() => store.setScale({ snap: !scale.snap })}
        >{scale.snap ? 'Locked' : 'Lock'}</button>
        <button type="button" className="text-btn" onClick={onClose} aria-label="Close scale library">×</button>
      </header>
      <p className="lib-hint">{hint}</p>
      {suggestion && (
        <button
          type="button"
          className="lib-suggest"
          {...describe(`The notes on this track sound like ${NOTE_NAMES[suggestion.root]} ${suggestion.name}.`)}
          onClick={() => applySuggestion(suggestion)}
        >Use {NOTE_NAMES[suggestion.root]} {suggestion.name}</button>
      )}
      <div className="chip-row" aria-label="Key and tradition">
        <select aria-label="Key" {...describe('Concert pitch of the tonic.')} value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
          {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
        </select>
        <button type="button" className={family === 'all' ? 'on' : ''} {...describe('Every tradition in the library.')} onClick={() => setFamily('all')}>All</button>
        {scaleFamilies().map((item) => (
          <button key={item.id} type="button" className={family === item.id ? 'on' : ''} {...describe(item.description)} onClick={() => setFamily(item.id)}>{item.name}</button>
        ))}
      </div>
      <div className="lib-search">
        <input aria-label="Search scales" placeholder="Search scales" {...describe('Find a scale by name or description.')} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="lib-body">
        <div className="lib-scales" aria-label="Scales">
          {scales.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeId ? 'on' : ''}
              {...describe(item.description)}
              onClick={() => choose(item.id)}
            >
              <b>{item.name}</b>
              <span>{item.description}</span>
            </button>
          ))}
          {!scales.length && <p className="lib-hint">No scales match.</p>}
        </div>
        <div className="lib-detail">
          <p className="lib-scale-name">{NOTE_NAMES[scale.root]} {active.name}</p>
          <p className="lib-hint">{active.description}</p>
          <div className="chip-row">
            <select
              aria-label="Voicing"
              {...describe(VOICINGS.find((item) => item.id === scale.voicing)?.description ?? 'How the chord is stacked.')}
              value={scale.voicing}
              onChange={(event) => store.setScale({ voicing: event.target.value as VoicingId })}
            >
              {VOICINGS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select aria-label="Inversion" {...describe('Which chord tone sits in the bass.')} value={scale.inversion} onChange={(event) => store.setScale({ inversion: Number(event.target.value) })}>
              {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value === 0 ? 'Root position' : `Inversion ${value}`}</option>)}
            </select>
            <select
              aria-label="Bass"
              {...describe('Keep the root in the bass, or choose another scale tone for a slash chord.')}
              value={bass == null ? '' : String(bass)}
              onChange={(event) => setBass(event.target.value === '' ? null : Number(event.target.value))}
            >
              <option value="">Bass: root</option>
              {degrees.map((tone, index) => <option key={`${tone.midi}-${tone.cents}-${index}`} value={index}>{toneName(tone)}</option>)}
            </select>
            <button type="button" className={scale.voiceLead ? 'on' : ''} {...describe('Move each chord as little as possible from the one before it.')} onClick={() => store.setScale({ voiceLead: !scale.voiceLead })}>Lead</button>
          </div>
          <div className="chip-row" aria-label="Chord type">
            {GROUPS.map((item) => (
              <button key={item.id} type="button" className={group === item.id ? 'on' : ''} {...describe(item.description)} onClick={() => setGroup(item.id)}>{item.name}</button>
            ))}
          </div>
          <div className="lib-chords">
            {chords.map((chord, index) => {
              const name = label(chord.symbol, chord.tones)
              return (
                <div key={`${chord.symbol}-${chord.degree}-${index}`} className="lib-chord">
                  <button type="button" {...describe(`Hear ${name}. ${chord.roman}.`)} onClick={() => hear(shape(chord.tones))}>{name}</button>
                  <button type="button" {...describe(`Write ${name} onto the selected MIDI track.`)} onClick={() => putChord(chord)}>Put</button>
                </div>
              )
            })}
            {!chords.length && <p className="lib-hint">No chords of this kind sit fully inside the scale.</p>}
          </div>
          <div className="lib-progress">
            {lines.map((line) => (
              <button
                key={line.pattern.id}
                type="button"
                {...describe(`${line.pattern.description} Writes the whole progression in one step.`)}
                onClick={() => putLine(line.chords, line.pattern.name)}
              >
                <b>{line.pattern.name}</b>
                <span>{line.chords.map((chord) => label(chord.symbol, chord.tones)).join('  ')}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function trackNotes(store: ProjectStore) {
  const selected = store.project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
    ?? store.project.tracks.find((track) => track.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
  const clips = selected?.midiClips ?? []
  const chosen = clips.filter((clip) => clip.id === store.selectedMidiClipId)
  const source = chosen.length ? chosen : clips
  return source.flatMap((clip) => clip.notes.filter((note) => !note.muted).map((note) => ({
    midi: note.pitch,
    cents: note.fine ?? 0,
    weight: Math.max(0.05, note.durationBeats),
  })))
}

function placeBass(tones: Tone[], bass: Tone): Tone[] {
  const voiced = withBass(tones, ((bass.midi % 12) + 12) % 12)
  if (!bass.cents) return voiced
  const lowest = Math.min(...voiced.map((tone) => tone.midi * 100 + tone.cents))
  let abs = bass.midi * 100 + bass.cents
  while (abs > lowest) abs -= 1200
  const placed = toneFromCents(abs)
  if (placed.midi < 0 || placed.midi > 127) return voiced
  return [placed, ...voiced.filter((tone) => tone.midi !== placed.midi || tone.cents !== placed.cents)]
}
