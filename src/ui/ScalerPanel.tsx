import { useEffect, useState, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { detectedScales, expressNotes, FIFTHS, modulationChords, moodOf, progressionMood, qualityLabel, type ModChord, type Mood } from '../instruments/scaler/face'
import { notesFromSlots } from '../instruments/scaler/clips'
import { SCALER_MIME, activeScaleId, chooseScale as pickScale, encodeScalerDrag, normalizeScaler, padPerformance, progressionPerformance, scalerChords } from '../instruments/scaler/model'
import type { ScalerGroup, ScalerNote, ScalerSound } from '../instruments/scaler/types'
import { NOTE_NAMES, type ArpDirection, type RhythmPattern } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import { allScales, getScale, harmonize, loadScaleCatalog, progressionsFor, realizeProgression, scaleFamilies, spellScale, VOICINGS, type VoicingId } from '../theory'
import { GeneratePanel } from './GeneratePop'
import { useFormFactor } from './form'
import { LibraryPanel } from './LibraryPanel'
import './scaler.css'

const GROUPS: { id: ScalerGroup; label: string }[] = [
  { id: 'triad', label: 'Triads' },
  { id: 'seventh', label: '7ths' },
  { id: 'ninth', label: '9ths' },
  { id: 'sus', label: 'Sus' },
  { id: 'add', label: 'Add' },
  { id: 'altered', label: 'Altered' },
]
const SOUNDS: { id: ScalerSound; label: string; hint: string }[] = [
  { id: 'synth', label: 'Soft Piano', hint: 'Play through the synth on this track.' },
  { id: 'sampler', label: 'Sampler', hint: 'Play through the sampler on this track.' },
  { id: '808', label: '808', hint: 'Play the chords with the 808.' },
  { id: 'drum-machine', label: 'Drums', hint: 'Play the chords as drum hits.' },
  { id: 'library', label: 'Library', hint: 'Play a multi-sample instrument from the free library.' },
  { id: 'forward', label: 'Track', hint: 'Send the MIDI to another instrument track.' },
]
const PERFORMS = [
  { label: 'Block', rhythm: 'block' as RhythmPattern, arp: 'off' as ArpDirection },
  { label: 'Animando', rhythm: 'eighth' as RhythmPattern, arp: 'up' as ArpDirection },
  { label: 'Strum', rhythm: 'strum' as RhythmPattern, arp: 'off' as ArpDirection },
  { label: 'Pulse', rhythm: 'sync' as RhythmPattern, arp: 'off' as ArpDirection },
]
const EXPRESSIONS = ['Still', 'Animando', 'Push']
const LOCKS = ['Off', 'Scale', 'Chord'] as const
const HUMAN = ['Off', 'Gentle', 'Strong']
const GATES = [0.25, 0.5, 0.8, 1]
const ARPS: ArpDirection[] = ['off', 'up', 'down', 'upDown', 'random']
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11])

interface Slot { symbol: string; roman: string; notes: ScalerNote[] }
interface Section { id: string; name: string; slots: (Slot | null)[] }

export function ScalerPanel({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const phone = useFormFactor() === 'phone'
  const [rec, setRec] = useState(false)
  const [pad, setPad] = useState(0)
  const [song, setSong] = useState(0)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState('all')
  const [, setCatalog] = useState(0)
  const [hint, setHint] = useState('Click a chord card. It plays, and Edit drops it into the lane.')
  const [st, setSt] = useState(0)
  const [locked, setLocked] = useState(false)
  const [octave, setOctave] = useState(0)
  const [perform, setPerform] = useState(0)
  const [expression, setExpression] = useState(0)
  const [lockMode, setLockMode] = useState(0)
  const [human, setHuman] = useState(0)
  const [modKind, setModKind] = useState(0)
  const [destRoot, setDestRoot] = useState(7)
  const [tab, setTab] = useState<'diatonic' | 'voicing' | 'variations' | 'modulation'>('diatonic')
  const [edit, setEdit] = useState(true)
  const [loop, setLoop] = useState(false)
  const [slot, setSlot] = useState(0)
  const [section, setSection] = useState(0)
  const [sections, setSections] = useState<Section[]>(() => [
    { id: 'intro', name: 'Intro', slots: blank() },
    { id: 'a', name: 'Part 1', slots: blank() },
    { id: 'b', name: 'Part 2', slots: blank() },
  ])
  useEffect(() => {
    let alive = true
    void loadScaleCatalog().then(() => { if (alive) setCatalog((value) => value + 1) })
    return () => { alive = false }
  }, [])

  const track = store.track(trackId)
  if (!track || track.type !== 'midi') return null
  const clips = track.midiClips
  const state = normalizeScaler(track.scaler)
  const scaleId = activeScaleId(state)
  const scaleName = getScale(scaleId).name
  const chords = scalerChords(state)
  const bar = Math.max(1, store.project.timeSignature?.numerator || 4)
  const songs = progressionsFor(scaleId)
  const songPattern = songs[song % Math.max(1, songs.length)]
  const diatonic = harmonize(state.root, scaleId, state.group === 'seventh' || state.group === 'ninth' ? 4 : 3)
  const degrees = spellScale(state.root, scaleId, 3)
  const scalePcs = new Set(degrees.map((tone) => mod12(tone.midi)))
  const current = chords[Math.min(pad, Math.max(0, chords.length - 1))]
  const chordPcs = new Set((current?.tones ?? []).map((tone) => mod12(tone.midi)))
  const trackNotes = clips.flatMap((clip) => clip.notes.filter((note) => !note.muted).map((note) => ({ midi: note.pitch, cents: note.fine })))
  const rows = detectedScales(trackNotes, state.root, scaleId)
  const playedNow = current ? padPerformance(state, Math.min(pad, chords.length - 1), bar) : null
  const liveNotes = (playedNow?.voiced ?? []).map((tone) => nameMidi(tone.midi)).join(' ')
  const families = scaleFamilies()
  const scales = allScales().filter((item) => {
    if (family !== 'all' && item.family !== family) return false
    const text = query.trim().toLowerCase()
    if (!text) return true
    return `${item.name} ${item.description}`.toLowerCase().includes(text)
  })
  const active = sections[section] ?? sections[0]
  const laneSymbols = active.slots.filter((item): item is Slot => !!item).map((item) => item.symbol)
  const songChords = songPattern ? realizeProgression(state.root, scaleId, songPattern, bar, 3).map((chord) => chord.symbol) : []
  const laneMood = progressionMood(laneSymbols.length ? laneSymbols : songChords, scaleId)
  const mods = ['secondary', 'parallel', 'mediant'] as const
  const modCopy = [
    { value: 'Secondary', hint: 'A path into the destination key, through its dominant seventh.' },
    { value: 'Borrowed', hint: 'Chords from the parallel major or minor. The home key stays.' },
    { value: 'Mediants', hint: 'Keys a third away, in both major and minor.' },
  ]
  const pathway = modulationChords(mods[modKind], state.root, scaleId, destRoot)
  const shapeCount = Math.max(1, Math.min(4, current?.tones.length ?? 3))
  const sound = SOUNDS.find((item) => item.id === state.sound) ?? SOUNDS[0]
  const gateIndex = GATES.reduce((best, value, index) => Math.abs(value - state.gate) < Math.abs(GATES[best] - state.gate) ? index : best, 0)

  function patch(next: Parameters<ProjectStore['setScaler']>[1]) {
    if (locked && (next.group || next.root != null || next.scale || next.library != null)) return
    store.setScaler(trackId, next)
  }

  function hear(notes: ScalerNote[], voiced?: { midi: number; cents: number }[]) {
    const shifted = notes
    engine.unlock()
    const beatSec = 60 / Math.max(40, store.project.tempo)
    const passes = loop ? 2 : 1
    const span = shifted.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
    const sequence = Array.from({ length: passes }, (_, pass) => shifted.map((note) => ({
      ...note,
      startBeat: note.startBeat + pass * span,
    }))).flat()
    engine.auditionScaler(trackId, sequence.map((note) => ({
      pitch: note.pitch,
      fine: note.fine,
      delay: note.startBeat * beatSec,
      duration: Math.max(0.05, note.durationBeats * beatSec),
      velocity: note.velocity,
    })))
    if (voiced?.length) store.rememberScalerVoice(trackId, voiced.map((tone) => tone.midi), voiced.map((tone) => tone.cents))
  }

  function atBeat(live: boolean) {
    const beat = Math.max(0, projectSampleBeat(store.project, engine.currentTimelineSample()))
    const moving = engine.status === 'playing' || engine.status === 'recording'
    if (live && moving) return beat
    if (live) {
      const take = clips.find((clip) => clip.name === 'Scaler')
      if (take) return take.startBeat + take.durationBeats
    }
    if (store.project.snap) return Math.floor(beat / bar) * bar
    return Math.floor(beat * 4) / 4
  }

  function playChord(index: number, write: boolean, override?: Partial<typeof state>) {
    const next = override ? normalizeScaler({ ...state, ...override }) : state
    const played = padPerformance(next, index, bar)
    if (override) patch(override)
    if (!played) return
    setPad(index)
    const notes = place(played.notes, st, octave, human, expression)
    setHint(`${played.symbol}. ${qualityLabel(played.symbol, played.roman)}. ${moodOf(played.symbol, scaleId).word}.`)
    hear(notes, played.voiced)
    if (edit) {
      setSections((prev) => prev.map((part, partIndex) => {
        if (partIndex !== section) return part
        const slots = part.slots.slice()
        slots[slot % 8] = { symbol: played.symbol, roman: played.roman, notes }
        return { ...part, slots }
      }))
      setSlot((value) => (value + 1) % 8)
    }
    const capture = write || rec || engine.status === 'recording'
    if (!capture) return
    if (write && !rec && engine.status !== 'recording') store.writeScalerClip(trackId, notes, atBeat(false), played.symbol)
    else store.recordScalerChord(trackId, notes, atBeat(true))
  }

  function laneNotes(): ScalerNote[] {
    const filled = active.slots.filter((item): item is Slot => !!item)
    if (!filled.length && songPattern) {
      const line = progressionPerformance(state, songPattern.id, bar)
      return place(line?.notes ?? [], st, octave, human, expression)
    }
    return notesFromSlots(active.slots, bar)
  }

  function captureLane() {
    const notes = laneNotes()
    if (!notes.length) {
      setHint('Pick a chord first. Capture writes the lane, or the song if the lane is empty.')
      return
    }
    store.writeScalerClip(trackId, notes, atBeat(false), active.name)
    setHint(`${active.name} is on the track as MIDI you can edit.`)
  }

  function loadSong(index: number) {
    const pattern = songs[index]
    if (!pattern) return
    setSong(index)
    const line = realizeProgression(state.root, scaleId, pattern, bar, 3)
    setSections((prev) => prev.map((part, partIndex) => {
      if (partIndex !== section) return part
      const slots = blank()
      line.forEach((chord, chordIndex) => {
        const notes = place(chord.tones.map((tone) => ({
          pitch: tone.midi,
          fine: tone.cents ? Math.round(tone.cents) : undefined,
          startBeat: 0,
          durationBeats: bar,
          velocity: 0.82,
        })), st, octave, human, expression)
        if (chordIndex < 8) slots[chordIndex] = { symbol: chord.symbol, roman: chord.roman, notes }
      })
      return { ...part, slots }
    }))
    const played = progressionPerformance(state, pattern.id, bar)
    if (played) hear(place(played.notes, st, octave, human, expression), played.voiced)
  }

  function playKey(midi: number) {
    let pitch = midi
    if (LOCKS[lockMode] === 'Scale' && !scalePcs.has(mod12(midi))) {
      pitch = nearestPc(midi, scalePcs)
    }
    if (LOCKS[lockMode] === 'Chord' && chordPcs.size && !chordPcs.has(mod12(midi))) {
      pitch = nearestPc(midi, chordPcs)
    }
    hear([{ pitch: pitch + st + octave * 12, startBeat: 0, durationBeats: 0.5, velocity: 0.84 }])
  }

  function playMod(step: ModChord) {
    const notes = place(step.tones.map((tone) => ({
      pitch: tone.midi,
      fine: tone.cents ? Math.round(tone.cents) : undefined,
      startBeat: 0,
      durationBeats: bar,
      velocity: 0.84,
    })), st, octave, human, expression)
    if (step.adopt) {
      const chosen = pickScale(step.scaleId)
      patch({ root: step.root, ...chosen, lastVoicing: [], lastCents: [] })
      setDestRoot(step.root)
    }
    setHint(`${step.symbol}. ${step.label}. ${moodOf(step.symbol, step.scaleId).word}.`)
    hear(notes)
    if (!edit) return
    setSections((prev) => prev.map((part, partIndex) => {
      if (partIndex !== section) return part
      const slots = part.slots.slice()
      slots[slot % 8] = { symbol: step.symbol, roman: step.roman, notes }
      return { ...part, slots }
    }))
    setSlot((value) => (value + 1) % 8)
  }

  function dragChord(event: DragEvent, notes: ScalerNote[], name: string) {
    const raw = encodeScalerDrag({ trackId, name, notes: place(notes, st, octave, human, expression) })
    event.dataTransfer.setData(SCALER_MIME, raw)
    event.dataTransfer.setData('text/plain', raw)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const fold = phone ? {} : { open: true }

  return (
    <div className={`scaler-panel ${phone ? 'phone' : ''}`} data-scaler="plugin" data-page={store.scalerPage} aria-label="Scaler">
      <header className="scaler-top">
        <strong>Scaler</strong>
        <div className="scaler-readout">
          <span>MIDI</span>
          <span>Notes <b>{liveNotes || '—'}</b></span>
          <span>Chord <b>{current?.symbol ?? '—'}</b></span>
        </div>
        <div className="scaler-strip">
          <Stepper label="Perform" value={PERFORMS[perform].label} hint="How the chord is performed." onStep={(dir) => {
            const next = cycle(perform, dir, PERFORMS.length)
            setPerform(next)
            patch({ rhythm: PERFORMS[next].rhythm, arp: PERFORMS[next].arp })
          }} />
          <Stepper label="Expressions" value={EXPRESSIONS[expression]} hint="A little push or stillness in the part." onStep={(dir) => setExpression(cycle(expression, dir, EXPRESSIONS.length))} />
          <Stepper label="Keys lock" value={LOCKS[lockMode]} hint="Off plays every key. Scale and Chord pull stray keys back." onStep={(dir) => {
            const next = cycle(lockMode, dir, LOCKS.length)
            setLockMode(next)
            patch({ snap: LOCKS[next] !== 'Off' })
          }} />
          <Stepper label="Voice grouping" value={VOICINGS[Math.max(0, VOICINGS.findIndex((item) => item.id === state.voicing))]?.name ?? 'Close'} hint="Voicing. How the chord is stacked." onStep={(dir) => {
            const index = Math.max(0, VOICINGS.findIndex((item) => item.id === state.voicing))
            patch({ voicing: VOICINGS[cycle(index, dir, VOICINGS.length)].id as VoicingId })
          }} />
          <Stepper label="Humanize" value={HUMAN[human]} hint="Leave a little of the played feel in the MIDI." onStep={(dir) => setHuman(cycle(human, dir, HUMAN.length))} />
          <Stepper label="Arpeggio" value={state.arp === 'off' ? 'Off' : state.arp === 'upDown' ? 'Up/down' : state.arp[0].toUpperCase() + state.arp.slice(1)} hint="Break the chord into single notes." onStep={(dir) => patch({ arp: ARPS[cycle(Math.max(0, ARPS.indexOf(state.arp)), dir, ARPS.length)] })} />
          <Stepper label="Gate" value={`${Math.round(GATES[gateIndex] * 100)}%`} hint="How long each note holds." onStep={(dir) => patch({ gate: GATES[cycle(gateIndex, dir, GATES.length)] })} />
        </div>
        <button type="button" className="scaler-close" title="Close Scaler. The track keeps the instrument." aria-label="Close Scaler. The track keeps the instrument." onClick={() => store.openScaler(trackId)}>×</button>
      </header>

      <div className="scaler-scroll">
        <div className="scaler-keys-row">
          <div className="scaler-sound">
            <Stepper label="Sound" value={sound.label} hint={sound.hint} onStep={(dir) => {
              const index = Math.max(0, SOUNDS.findIndex((item) => item.id === state.sound))
              patch({ sound: SOUNDS[cycle(index, dir, SOUNDS.length)].id })
            }} />
            <div className="scaler-sounds" role="group" aria-label="Sound. Which instrument plays the chords.">
              {SOUNDS.map((item) => (
                <button key={item.id} type="button" className={state.sound === item.id ? 'on' : ''} aria-pressed={state.sound === item.id} title={item.hint} onClick={() => patch({ sound: item.id })}>{item.label}</button>
              ))}
            </div>
            {state.sound === 'forward' && (
              <div className="scaler-forward">
                {store.project.tracks.filter((item) => item.type === 'midi' && item.id !== trackId).map((item) => (
                  <button key={item.id} type="button" className={state.forwardTrackId === item.id ? 'on' : ''} onClick={() => patch({ forwardTrackId: item.id })}>{item.name}</button>
                ))}
              </div>
            )}
            {state.sound === 'library' && <LibraryPanel store={store} engine={engine} trackId={trackId} />}
          </div>
          <Piano start={24} end={72} scalePcs={scalePcs} chordPcs={chordPcs} locked={LOCKS[lockMode] !== 'Off'} onPlay={playKey} />
        </div>

        <div className="scaler-browser">
          <button type="button" title="Guess the key from the MIDI on this track." onClick={() => {
            if (!store.detectScaler(trackId)) setHint('Draw or record a few notes first. Detect reads the MIDI on this track.')
            else setHint('Detected a key from the notes on this track.')
          }}>Detect</button>
          <button type="button" title="Browse scales inside the plugin." onClick={() => setFamily('all')}>Scales</button>
          <Stepper label="Songs" value={songPattern?.name ?? 'Song'} hint={songPattern?.description ?? 'A progression in this key.'} onStep={(dir) => loadSong(cycle(song, dir, songs.length))} />
          <Stepper label="Chord set" value={GROUPS.find((item) => item.id === state.group)?.label ?? 'Triads'} hint="Which chords the pads show." onStep={(dir) => {
            const index = Math.max(0, GROUPS.findIndex((item) => item.id === state.group))
            setPad(0)
            patch({ group: GROUPS[cycle(index, dir, GROUPS.length)].id, inversion: 0, lastVoicing: [], lastCents: [] })
          }} />
          <button type="button" className={family === 'western' ? 'on' : ''} title="Western scales in the library." onClick={() => setFamily(family === 'western' ? 'all' : 'western')}>User</button>
          <span className={`mood-pill ${laneMood.feel.toLowerCase()}`} title="Whether this progression feels bright and lifting or dark and tense.">{laneMood.feel}</span>
        </div>

        <div className="scaler-transport">
          <Stepper label="St" value={String(st)} hint="Transpose the chords, in semitones." onStep={(dir) => { if (!locked) setSt(clamp(st + dir, -12, 12)) }} />
          <button type="button" className={locked ? 'on' : ''} aria-pressed={locked} title="Lock the key, the chord set, and transpose." onClick={() => setLocked((value) => !value)}>{locked ? 'Locked' : 'Lock'}</button>
        </div>

        <div className="scaler-pads" role="group" aria-label="Chord pads">
          {chords.slice(0, 12).map((chord, index) => {
            const mood = moodOf(chord.symbol, scaleId)
            return (
              <button
                key={`${chord.symbol}-${index}`}
                type="button"
                className={`scaler-card ${pad === index ? 'on' : ''}`}
                aria-pressed={pad === index}
                draggable
                title={`Hear ${chord.symbol}. ${qualityLabel(chord.symbol, chord.roman)}. ${mood.word}. Drag it onto a track or into the lane.`}
                onDragStart={(event) => {
                  const played = padPerformance(state, index, bar)
                  if (played) dragChord(event, played.notes, played.symbol)
                }}
                onClick={() => playChord(index, false)}
              >
                <i className="bar" data-mood={mood.word} />
                <b>{chord.symbol}</b>
                <span>{qualityLabel(chord.symbol, chord.roman)}</span>
                <MoodMeter mood={mood} />
              </button>
            )
          })}
          {!chords.length && <p className="scaler-hint">No chords of this kind sit inside the scale.</p>}
        </div>

        <details className="scaler-fold" {...fold}>
          <summary>Detected scales</summary>
          <div className="scaler-table" role="table" aria-label="Detected scales">
            <div className="head" role="row"><span>Scale</span><span>Notes</span><span>Chords</span><span>Style</span><span>Mode</span></div>
            {rows.map((row) => (
              <button key={`${row.root}-${row.scaleId}`} type="button" role="row" className={row.root === state.root && (row.scaleId === scaleId || row.scaleId === state.scale) ? 'on' : ''} onClick={() => {
                const chosen = pickScale(row.scaleId)
                patch({ root: row.root, ...chosen, lastVoicing: [], lastCents: [] })
                const scaleChord = harmonize(row.root, row.scaleId, 3)[0]
                if (scaleChord) hear(place(scaleChord.tones.map((tone, index) => ({ pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined, startBeat: index * 0.5, durationBeats: 0.45, velocity: 0.8 })), st, octave, human, expression))
              }}>
                <span><em>▶</em> {NOTE_NAMES[row.root]} {row.name}</span>
                <span>{row.notes}</span>
                <span>{row.chords}</span>
                <span>{row.style}</span>
                <span>{row.mode}</span>
              </button>
            ))}
          </div>
          <div className="scaler-scale-tools">
            <div className="scaler-families">
              <button type="button" className={family === 'all' ? 'on' : ''} onClick={() => setFamily('all')}>All</button>
              {families.slice(0, 8).map((item) => (
                <button key={item.id} type="button" className={family === item.id ? 'on' : ''} title={item.description} onClick={() => setFamily(item.id)}>{item.name}</button>
              ))}
            </div>
            <input aria-label="Search scales" title="Find a scale by name." placeholder="Search scales" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="scaler-scale-list">
              {scales.slice(0, 24).map((item) => (
                <button key={item.id} type="button" className={item.id === scaleId ? 'on' : ''} title={item.description} onClick={() => patch({ ...pickScale(item.id), lastVoicing: [], lastCents: [] })}>{item.name}</button>
              ))}
            </div>
          </div>
        </details>

        <section className="scaler-selected">
          <div className="scaler-tabs">
            <b>{NOTE_NAMES[state.root]} {scaleName}</b>
            {(['diatonic', 'voicing', 'variations', 'modulation'] as const).map((id) => (
              <button key={id} type="button" className={tab === id ? 'on' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}>
                {id === 'voicing' ? `Voicing ${Math.max(1, VOICINGS.findIndex((item) => item.id === state.voicing) + 1)}` : id[0].toUpperCase() + id.slice(1)}
              </button>
            ))}
            <Stepper label="Octave" value={String(octave + 2)} hint="Shift the played chords by octaves." onStep={(dir) => setOctave(clamp(octave + dir, -2, 2))} />
          </div>
          {tab === 'diatonic' && (
            <div className="scaler-pads diatonic" role="group" aria-label="Diatonic chords">
              {diatonic.map((chord, index) => {
                const mood = moodOf(chord.symbol, scaleId)
                return (
                  <button key={`${chord.symbol}-${index}`} type="button" className="scaler-card" title={`${chord.symbol}. ${qualityLabel(chord.symbol, chord.roman)}. ${mood.word}.`} onClick={() => {
                    hear(place(chord.tones.map((tone) => ({ pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined, startBeat: 0, durationBeats: bar, velocity: 0.84 })), st, octave, human, expression))
                    if (edit) {
                      const notes = place(chord.tones.map((tone) => ({ pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined, startBeat: 0, durationBeats: bar, velocity: 0.84 })), st, octave, human, expression)
                      setSections((prev) => prev.map((part, partIndex) => partIndex === section ? { ...part, slots: part.slots.map((item, itemIndex) => itemIndex === slot ? { symbol: chord.symbol, roman: chord.roman, notes } : item) } : part))
                      setSlot((value) => (value + 1) % 8)
                    }
                  }}>
                    <i className="bar" data-mood={mood.word} />
                    <b>{chord.symbol}</b>
                    <span>{qualityLabel(chord.symbol, chord.roman)}</span>
                    <MoodMeter mood={mood} />
                  </button>
                )
              })}
            </div>
          )}
          {tab === 'voicing' && (
            <div className="scaler-voice-read">
              <p>{VOICINGS.find((item) => item.id === state.voicing)?.description}</p>
              <p className="notes">{liveNotes || 'Play a pad to see the voicing.'}</p>
              <div className="scaler-families">
                {VOICINGS.map((item) => (
                  <button key={item.id} type="button" className={state.voicing === item.id ? 'on' : ''} title={item.description} onClick={() => patch({ voicing: item.id })}>{item.name}</button>
                ))}
              </div>
              <Stepper label="Inversion" value={state.inversion % shapeCount === 0 ? 'Root' : String(state.inversion % shapeCount)} hint="Which chord tone sits lowest." onStep={(dir) => patch({ inversion: clamp((state.inversion % shapeCount) + dir, 0, shapeCount - 1) })} />
            </div>
          )}
          {tab === 'variations' && current && (
            <div className="scaler-pads" role="group" aria-label="Inversions">
              {Array.from({ length: shapeCount }, (_, inversion) => (
                <button key={inversion} type="button" className={`scaler-card ${state.inversion % shapeCount === inversion ? 'on' : ''}`} onClick={() => playChord(pad, false, { inversion })}>
                  <i className="bar" data-mood={moodOf(current.symbol, scaleId).word} />
                  <b>{current.symbol}</b>
                  <span>{inversion === 0 ? 'Root' : `Inversion ${inversion}`}</span>
                </button>
              ))}
            </div>
          )}
          {tab === 'modulation' && (
            <div className="scaler-mod">
              <Fifths root={destRoot} home={state.root} onPick={setDestRoot} />
              <div>
                <Stepper label="Modulation" value={modCopy[modKind].value} hint={modCopy[modKind].hint} onStep={(dir) => setModKind(cycle(modKind, dir, 3))} />
                <p className="scaler-hint">From {NOTE_NAMES[state.root]} toward {NOTE_NAMES[destRoot]}. Pick a destination chord to land there.</p>
                <div className="scaler-pads" aria-label="Modulation pathway">
                  {pathway.map((step, index) => (
                    <ModCard key={`${step.symbol}-${step.label}-${index}`} step={step} onPlay={() => playMod(step)} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="scaler-lane" aria-label="Progression lane">
          <div className="scaler-sections">
            {sections.map((part, index) => (
              <button key={part.id} type="button" className={section === index ? 'on' : ''} aria-pressed={section === index} onClick={() => { setSection(index); setSlot(0) }}>{part.name}</button>
            ))}
            <button type="button" title="Add a section." onClick={() => setSections((prev) => prev.length >= 6 ? prev : [...prev, { id: `part-${prev.length}`, name: `Part ${prev.length}`, slots: blank() }])}>+</button>
          </div>
          <div className="scaler-lane-row">
            <div className="scaler-lane-tools">
              <button type="button" className={loop ? 'on' : ''} aria-pressed={loop} title="Preview the lane twice." onClick={() => setLoop((value) => !value)}>Loop</button>
              <button type="button" title="Hear this section." onClick={() => hear(laneNotes())}>Play</button>
              <button type="button" className={edit ? 'on' : ''} aria-pressed={edit} title="Edit. Clicks also fill the selected slot." onClick={() => setEdit((value) => !value)}>Edit</button>
            </div>
            <div className="scaler-slots">
              {active.slots.map((item, index) => (
                <button
                  key={index}
                  type="button"
                  className={`slot ${slot === index ? 'focus' : ''} ${item ? 'filled' : ''}`}
                  aria-pressed={slot === index}
                  onClick={() => setSlot(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    const raw = event.dataTransfer.getData(SCALER_MIME) || event.dataTransfer.getData('text/plain')
                    try {
                      const parsed = JSON.parse(raw) as { name?: string; notes?: ScalerNote[] }
                      if (!parsed.notes?.length) return
                      setSections((prev) => prev.map((part, partIndex) => partIndex === section ? { ...part, slots: part.slots.map((slotItem, slotIndex) => slotIndex === index ? { symbol: parsed.name || 'Chord', roman: '', notes: parsed.notes! } : slotItem) } : part))
                    } catch { /* not a scaler drag */ }
                  }}
                >
                  {item ? <b>{item.symbol}</b> : <b>{index + 1}</b>}
                  {item && <span>{qualityLabel(item.symbol, item.roman)}</span>}
                  {item && <MoodMeter mood={moodOf(item.symbol, scaleId)} />}
                </button>
              ))}
            </div>
            <div className="scaler-lane-tools">
              <button type="button" className={rec || engine.status === 'recording' ? 'on' : ''} aria-pressed={rec} title="Record each pad as MIDI on this track." onClick={() => setRec((value) => !value)}>Rec</button>
              <button type="button" title="Put the selected chord on the timeline as MIDI." onClick={() => playChord(pad, true)}>To track</button>
              <button type="button" title="Write this section onto the track as editable MIDI." onClick={captureLane}>MIDI capture</button>
              <button type="button" title="Drag this section onto a MIDI track." draggable onDragStart={(event) => dragChord(event, laneNotes(), active.name)}>Drag</button>
            </div>
          </div>
          <p className="scaler-hint">{hint} This lane feels {laneMood.feel.toLowerCase()} ({laneMood.word}).</p>
        </section>

        <details className="scaler-fold">
          <summary>Write</summary>
          <GeneratePanel store={store} engine={engine} trackId={trackId} scale={{ root: state.root, scale: state.scale, library: state.library }} />
        </details>
      </div>
    </div>
  )
}

function Stepper({ label, value, hint, onStep }: { label: string; value: string; hint: string; onStep: (dir: number) => void }) {
  return (
    <div className="stepper" title={hint}>
      <span>{label}</span>
      <button type="button" aria-label={`Previous ${label}. ${hint}`} onClick={() => onStep(-1)}>&lt;</button>
      <b>{value}</b>
      <button type="button" aria-label={`Next ${label}. ${hint}`} onClick={() => onStep(1)}>&gt;</button>
    </div>
  )
}

function MoodMeter({ mood }: { mood: Mood }) {
  const place = Math.round(((mood.score + 1) / 2) * 100)
  return (
    <span className="mood" data-mood={mood.word} title={`${mood.word}. ${mood.feel}. Bright is major and lifting. Dark is minor and tense.`}>
      <span className="mood-scale" aria-hidden="true">
        <i data-mood={mood.word} style={{ left: `${place}%` }} />
      </span>
      <em>{mood.word}</em>
    </span>
  )
}

function Piano({ start, end, scalePcs, chordPcs, locked, onPlay }: { start: number; end: number; scalePcs: Set<number>; chordPcs: Set<number>; locked: boolean; onPlay: (midi: number) => void }) {
  const whites: number[] = []
  const blacks: { midi: number; after: number }[] = []
  for (let midi = start; midi <= end; midi++) {
    if (WHITE.has(midi % 12)) whites.push(midi)
    else blacks.push({ midi, after: whites.length - 1 })
  }
  const klass = (midi: number) => {
    const pc = midi % 12
    if (chordPcs.has(pc)) return 'chord'
    if (scalePcs.has(pc)) return 'scale'
    return ''
  }
  return (
    <div className="scaler-keys" style={{ ['--whites' as string]: whites.length }} aria-label="Keyboard. Amber keys are in the scale. Cyan keys are the chord.">
      <div className="scaler-whites">
        {whites.map((midi) => (
          <button key={midi} type="button" className={klass(midi)} aria-label={NOTE_NAMES[midi % 12]} onClick={() => onPlay(midi)}>
            {midi % 12 === 0 && <small>C{Math.floor(midi / 12) - 1}</small>}
            {locked && scalePcs.has(midi % 12) && <i />}
          </button>
        ))}
      </div>
      <div className="scaler-blacks">
        {blacks.map((key) => (
          <button key={key.midi} type="button" className={klass(key.midi)} style={{ left: `${((key.after + 1) / whites.length) * 100}%` }} aria-label={NOTE_NAMES[key.midi % 12]} onClick={() => onPlay(key.midi)} />
        ))}
      </div>
    </div>
  )
}

function ModCard({ step, onPlay }: { step: ModChord; onPlay: () => void }) {
  const mood = moodOf(step.symbol, step.scaleId)
  return (
    <button type="button" className="scaler-card" title={`${step.symbol}. ${step.label}. ${mood.word}.`} onClick={onPlay}>
      <i className="bar" data-mood={mood.word} />
      <b>{step.symbol}</b>
      <span>{step.label}</span>
      <MoodMeter mood={mood} />
    </button>
  )
}

function Fifths({ root, home, onPick }: { root: number; home: number; onPick: (pc: number) => void }) {
  return (
    <div className="fifths" aria-label="Circle of fifths">
      <div className="hub">Fifths</div>
      {FIFTHS.map((pc, index) => (
        <button
          key={pc}
          type="button"
          className={`${pc === root ? 'on' : ''} ${pc === home && pc !== root ? 'home' : ''}`}
          title={pc === home ? `${NOTE_NAMES[pc]} is the current key.` : `Aim the pathway at ${NOTE_NAMES[pc]}.`}
          style={{ transform: `rotate(${index * 30}deg) translateY(-78px) rotate(${-index * 30}deg)` }}
          onClick={() => onPick(pc)}
        >
          {NOTE_NAMES[pc]}
        </button>
      ))}
    </div>
  )
}

function blank(): (Slot | null)[] {
  return Array.from({ length: 8 }, () => null)
}

function place(notes: ScalerNote[], semitones: number, octave: number, human: number, expression = 0): ScalerNote[] {
  const shifted = notes.map((note) => {
    const sway = human === 0 ? 1 : human === 1 ? 0.92 + (note.pitch % 5) * 0.02 : 0.78 + (note.pitch % 7) * 0.04
    return {
      ...note,
      pitch: clamp(Math.round(note.pitch + semitones + octave * 12), 0, 127),
      velocity: clamp(note.velocity * sway, 0.05, 1),
    }
  })
  return expressNotes(shifted, expression)
}

function nearestPc(midi: number, pcs: Set<number>) {
  if (!pcs.size) return midi
  for (let step = 0; step < 12; step++) {
    if (pcs.has(mod12(midi + step))) return midi + step
    if (pcs.has(mod12(midi - step))) return midi - step
  }
  return midi
}

function nameMidi(midi: number) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

function cycle(index: number, dir: number, length: number) {
  if (!length) return 0
  return (index + dir + length) % length
}

function mod12(midi: number) {
  return ((midi % 12) + 12) % 12
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
