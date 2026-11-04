import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { detectedScales, FIFTHS, modulationChords, moodOf, progressionMood, qualityLabel, type ModChord, type Mood } from '../instruments/scaler/face'
import { notesFromSlots } from '../instruments/scaler/clips'
import { playScalerLive } from '../instruments/scaler/live'
import { chordsFromMidi } from '../instruments/scaler/listen'
import { SCALER_MIME, activeScaleId, chooseScale as pickScale, encodeScalerDrag, normalizeScaler, padPerformance, progressionPerformance, scalerChords } from '../instruments/scaler/model'
import { applyExpression, EXPRESSIONS, humanizeNotes, KEYS_LOCK_LABELS, KEYS_LOCKS, loadPerformanceLibrary, lockPadNotes, moveItem, patternCatalog, performanceCatalog, styleCatalog, type KeysLock } from '../instruments/scaler/perform'
import type { ScalerGroup, ScalerInput, ScalerNote, ScalerOutput, ScalerSound, VoiceGroup } from '../instruments/scaler/types'
import { NOTE_NAMES, type ArpDirection } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import { allProgressions, allScales, GENRE_INFO, getScale, harmonize, loadScaleCatalog, progressionsFor, realizeProgression, scaleFamilies, songSets, spellScale, VOICINGS, type VoicingId } from '../theory'
import { GeneratePanel } from './GeneratePop'
import { scalerPatch } from '../presets/apply'
import { commitScalerPreset } from '../presets/project'
import { ScalerPerformances } from './ScalerPerformances'
import { useFormFactor } from './form'
import { PresetControls } from './PresetControls'
import { useScreenOverlay } from './screenOverlay'
import { LibraryPanel } from './LibraryPanel'
import './scaler.css'

const SECTION_MIME = 'application/x-cueharbor-section'

const GROUPS: { id: ScalerGroup; label: string }[] = [
  { id: 'triad', label: 'Triads' },
  { id: 'seventh', label: 'Sevenths' },
  { id: 'ninth', label: 'Ninths' },
  { id: 'sus', label: 'Suspended' },
  { id: 'add', label: 'Added' },
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
const HUMAN = ['Off', 'Gentle', 'Strong']
const GATES = [0.25, 0.5, 0.8, 1]
const RATES = [1, 0.5, 0.25, 0.125]
const RATE_LABEL = ['Whole', 'Half', 'Quarter', 'Eighth']
const SWINGS = [0, 0.08, 0.16, 0.33]
const SWING_LABEL = ['Straight', 'Light', 'Swing', 'Hard']
const ARPS: ArpDirection[] = ['off', 'up', 'down', 'upDown', 'random']
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11])
const KEY_WORD = ['C', 'C sharp', 'D', 'D sharp', 'E', 'F', 'F sharp', 'G', 'G sharp', 'A', 'A sharp', 'B']
const VOICE_GROUPS: { id: VoiceGroup; voicing?: VoicingId; label: string }[] = [
  { id: 'all', voicing: 'close', label: 'Close' },
  { id: 'all', voicing: 'drop2', label: 'Drop 2' },
  { id: 'all', voicing: 'drop3', label: 'Drop 3' },
  { id: 'all', voicing: 'spread', label: 'Spread' },
  { id: 'all', voicing: 'shell', label: 'Shell' },
  { id: 'all', voicing: 'rootless', label: 'Rootless' },
  { id: 'bass', label: 'Bass' },
  { id: 'upper', label: 'Upper' },
  { id: 'dynamic', voicing: 'spread', label: 'Dynamic' },
]

interface Slot { symbol: string; roman: string; notes: ScalerNote[] }
interface Section { id: string; name: string; slots: (Slot | null)[] }

export function ScalerPanel({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const form = useFormFactor()
  const [rec, setRec] = useState(false)
  const [pad, setPad] = useState(0)
  const [song, setSong] = useState(0)
  const [genre, setGenre] = useState('all')
  const [category, setCategory] = useState('Arpeggio')
  const [songQuery, setSongQuery] = useState('')
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState('all')
  const [, setCatalog] = useState(0)
  const [hint, setHint] = useState('Click a chord card. It plays, and Edit drops it into the lane.')
  const [st, setSt] = useState(0)
  const [locked, setLocked] = useState(false)
  const [octave, setOctave] = useState(0)
  const [expression, setExpression] = useState(0)
  const [human, setHuman] = useState(0)
  const [perfOpen, setPerfOpen] = useState(false)
const [options, setOptions] = useState(false)
  useScreenOverlay(() => store.closeScaler())
  const perfButton = useRef<HTMLButtonElement>(null)
  const [audioHeard, setAudioHeard] = useState<string[]>([])
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
    void loadPerformanceLibrary().then(() => { if (alive) setCatalog((value) => value + 1) })
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
  const library = allProgressions()
  const sets = songSets().filter((item) => genre === 'all' || item.genre === genre)
  const activeSet = sets[song % Math.max(1, sets.length)]
  const songLines = library.filter((item) => activeSet?.progressionIds.includes(item.id))
  const songPattern = songLines[0] ?? progressionsFor(scaleId)[0]
  const diatonic = harmonize(state.root, scaleId, state.group === 'seventh' || state.group === 'ninth' ? 4 : 3)
  const degrees = spellScale(state.root, scaleId, 3)
  const scalePcs = new Set(degrees.map((tone) => mod12(tone.midi)))
  const current = chords[Math.min(pad, Math.max(0, chords.length - 1))]
  const chordPcs = new Set((current?.tones ?? []).map((tone) => mod12(tone.midi)))
  const trackNotes = clips.flatMap((clip) => clip.notes.filter((note) => !note.muted).map((note) => ({ midi: note.pitch, cents: note.fine, startBeat: note.startBeat, durationBeats: note.durationBeats })))
  const rows = detectedScales(trackNotes, state.root, scaleId)
  const midiChords = chordsFromMidi(trackNotes)
  const styled = styleCatalog()
  const performances = styled.length
    ? styled.filter((item) => category === 'All' || item.category === category)
    : performanceCatalog().filter((item) => category === 'All' || item.category === category)
  const performance = performances.find((item) => item.id === state.performanceId) ?? performanceCatalog().find((item) => item.id === state.performanceId)
  const expressionId = EXPRESSIONS[expression]?.id ?? 'still'
  const voiceLabel = VOICE_GROUPS.find((item) => item.id === state.voiceGroup && (item.voicing == null || item.voicing === state.voicing))?.label
    ?? (state.voiceGroup === 'dynamic' ? 'Dynamic' : state.voiceGroup === 'bass' ? 'Bass' : state.voiceGroup === 'upper' ? 'Upper' : 'Close')
  const playedNow = current ? padPerformance(state, Math.min(pad, chords.length - 1), bar) : null
  const liveNotes = (playedNow?.voiced ?? []).map((tone) => nameMidi(tone.midi)).join(' ')
  const families = scaleFamilies()
const scaleList = allScales()
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

  function hear(notes: ScalerNote[], voiced?: { midi: number; cents: number }[], chordIndex = pad) {
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
    })), state.output)
    if (voiced?.length) store.rememberScalerVoice(trackId, voiced.map((tone) => tone.midi), voiced.map((tone) => tone.cents), chordIndex)
  }

  function atBeat(live: boolean) {
    const beat = Math.max(0, projectSampleBeat(store.project, engine.currentTimelineSample()))
    const moving = engine.status === 'playing' || engine.status === 'recording'
    if (!live) return beat
    if (moving) return beat
    const take = clips.find((clip) => clip.name === 'Scaler')
    if (take) return take.startBeat + take.durationBeats
    return beat
  }

  function playChord(index: number, write: boolean, override?: Partial<typeof state>) {
    const next = override ? normalizeScaler({ ...state, ...override, chordIndex: index }) : state
    const played = padPerformance(next, index, bar)
    if (override) patch(override)
    if (!played) return
    setPad(index)
    const notes = lockPadNotes(place(played.notes, st, octave, human, expressionId), state.keysLock, state.root, state.scale, state.library)
    if (!notes.length) return
    setHint(`${played.symbol}. ${qualityLabel(played.symbol, played.roman)}. ${moodOf(played.symbol, scaleId).word}.`)
    hear(notes, played.voiced, index)
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
    const written = state.recordSource === 'input' ? notes.slice(0, 1) : notes
    if (write && !rec && engine.status !== 'recording') store.writeScalerClip(trackId, written, atBeat(false), played.symbol)
    else store.recordScalerChord(trackId, written, atBeat(true))
  }

  function laneNotes(): ScalerNote[] {
    const filled = active.slots.filter((item): item is Slot => !!item)
    if (!filled.length && songPattern) {
      const line = progressionPerformance(state, songPattern.id, bar)
      return place(line?.notes ?? [], st, octave, human, expressionId)
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

  function loadProgression(pattern: (typeof library)[number]) {
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
        })), st, octave, human, expressionId)
        if (chordIndex < 8) slots[chordIndex] = { symbol: chord.symbol, roman: chord.roman, notes }
      })
      return { ...part, slots }
    }))
    const played = progressionPerformance(state, pattern.id, bar)
    if (played) hear(place(played.notes, st, octave, human, expressionId), played.voiced)
    setHint(`${pattern.name}. ${pattern.description}`)
  }

  function playKey(midi: number) {
    const played = playScalerLive(store.project, engine, trackId, midi + st + octave * 12, 0.84)
    if (!played?.length) return
    setHint(`${played.length === 1 ? 'One note' : `${played.length} notes`} through Scaler.`)
    const capture = rec || engine.status === 'recording'
    if (capture) store.recordScalerChord(trackId, played.map((note) => ({ pitch: note.midi, fine: note.cents ? Math.round(note.cents) : undefined, startBeat: 0, durationBeats: bar, velocity: 0.84 })), atBeat(true))
  }

  function playMod(step: ModChord) {
    const notes = place(step.tones.map((tone) => ({
      pitch: tone.midi,
      fine: tone.cents ? Math.round(tone.cents) : undefined,
      startBeat: 0,
      durationBeats: bar,
      velocity: 0.84,
    })), st, octave, human, expressionId)
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
    const raw = encodeScalerDrag({ trackId, name, notes: place(notes, st, octave, human, expressionId) })
    event.dataTransfer.setData(SCALER_MIME, raw)
    event.dataTransfer.setData('text/plain', raw)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const rateIndex = RATES.reduce((best, value, index) => Math.abs(value - state.rate) < Math.abs(RATES[best] - state.rate) ? index : best, 0)
  const swingIndex = SWINGS.reduce((best, value, index) => Math.abs(value - state.swing) < Math.abs(SWINGS[best] - state.swing) ? index : best, 0)
  const lockIndex = Math.max(0, KEYS_LOCKS.indexOf(state.keysLock))
  const progressCount = library.length
  const patternCount = patternCatalog().length
  const performanceCount = performanceCatalog().length

  return (
    <div className={`scaler-panel ${form === 'desk' ? '' : form}`} data-scaler="plugin" data-page={store.scalerPage} data-progressions={progressCount} data-patterns={patternCount} data-performances={performanceCount} data-screen-overlay="" aria-label="Scaler">
      <PresetControls
        pluginId="scaler"
        instanceKey={`scaler:${trackId}`}
        values={{
          root: state.root,
          inversion: state.inversion,
          gate: state.gate,
          rate: state.rate,
          swing: state.swing,
          octaves: state.octaves,
          snap: state.snap ? 1 : 0,
          voiceLead: state.voiceLead ? 1 : 0,
        }}
        text={{ scale: state.scale, group: state.group, voicing: state.voicing, sound: state.sound, arp: state.arp, rhythm: state.rhythm }}
        presets={store.project.presets}
        onCommit={(next) => commitScalerPreset(store, trackId, scalerPatch(next.params, next.text), next.presets)}
      />
      <header className="scaler-head">
        <div className="scaler-key-pick">
          <span className="scaler-label" id="scaler-key-label">Key</span>
          <div className="scaler-key-scroll" role="group" aria-labelledby="scaler-key-label" data-key-picker="">
            {NOTE_NAMES.map((name, pc) => (
              <button
                key={name}
                type="button"
                className={state.root === pc ? 'on' : ''}
                aria-pressed={state.root === pc}
                aria-label={`Key ${KEY_WORD[pc]}`}
                title={`Set the key to ${KEY_WORD[pc]}.`}
                disabled={locked}
                onClick={() => patch({ root: pc, lastVoicing: [], lastCents: [] })}
              >{name}</button>
            ))}
          </div>
        </div>
        <label className="scaler-scale" data-scale-picker="">
          <span>Scale</span>
          <select
            aria-label="Scale"
            title="Choose the scale. Keys in the scale light up."
            value={scaleId}
            disabled={locked}
            onChange={(event) => patch({ ...pickScale(event.target.value), lastVoicing: [], lastCents: [] })}
          >
            {families.map((group) => {
              const items = scaleList.filter((item) => item.family === group.id)
              if (!items.length) return null
              return (
                <optgroup key={group.id} label={group.name}>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </optgroup>
              )
            })}
            {!scaleList.some((item) => item.id === scaleId) && <option value={scaleId}>{scaleName}</option>}
          </select>
        </label>
        <button type="button" className="scaler-close overlay-close" title="Close Scaler. The track keeps the instrument." aria-label="Close Scaler. The track keeps the instrument." onClick={() => store.openScaler(trackId)}>Close</button>
      </header>
      <div className="scaler-tools" role="group" aria-label="Output" data-output="">
        <button type="button" className="btn-secondary" title="Send the selected chord to this track at the playhead." onClick={() => playChord(pad, true)}>To track</button>
        <div className="scaler-pills">
        <button type="button" className={`btn-quiet ${state.output !== 'midi' ? 'on' : ''}`} aria-pressed={state.output !== 'midi'} title="Play the chords through this track." onClick={() => patch({ output: (state.output === 'audio' ? 'both' : state.output === 'both' ? 'midi' : 'audio') satisfies ScalerOutput })}>Audio output</button>
        <button type="button" className={`btn-quiet ${state.output !== 'audio' ? 'on' : ''}`} aria-pressed={state.output !== 'audio'} title="Send the chords as MIDI." onClick={() => patch({ output: (state.output === 'midi' ? 'both' : state.output === 'both' ? 'audio' : 'midi') satisfies ScalerOutput })}>MIDI output</button>
        <button type="button" className={`btn-quiet ${state.input === 'midi' ? 'on' : ''}`} aria-pressed={state.input === 'midi'} title="Detect reads the MIDI on this track." onClick={() => patch({ input: 'midi' satisfies ScalerInput })}>MIDI input</button>
        <button type="button" className={`btn-quiet ${state.input === 'audio' ? 'on' : ''}`} aria-pressed={state.input === 'audio'} title="Detect reads an audio clip in this project." onClick={() => patch({ input: 'audio' satisfies ScalerInput })}>Audio input</button>
        </div>
        <button type="button" className={`btn-quiet ${options ? 'on' : ''}`} aria-expanded={options} aria-controls="scaler-options" title="Chords, songs, performances, and the rest of Scaler." onClick={() => setOptions((value) => !value)}>Options</button>
      </div>
      <div id="scaler-options" className="scaler-drawer" hidden={!options}>
        <div className="scaler-readout">
          <span>Notes <b>{liveNotes || 'Rest'}</b></span>
          <span>Chord <b>{current?.symbol ?? 'Rest'}</b></span>
        </div>
        <div className="scaler-strip">
          <button
            ref={perfButton}
            type="button"
            className={perfOpen ? 'on' : ''}
            aria-expanded={perfOpen}
            aria-label="Performances"
            title="Styles, packs, variation, and where the MIDI goes."
            onClick={() => setPerfOpen((value) => !value)}
          >Performances</button>
          <ScalerPerformances
            open={perfOpen}
            onClose={() => setPerfOpen(false)}
            triggerRef={perfButton}
            store={store}
            trackId={trackId}
            state={state}
            pad={pad}
            bar={bar}
            onHear={(notes) => hear(notes)}
          />
          <Stepper label="Perform" value={performance?.name ?? 'Block'} hint="Arpeggio, strum, rhythm, bass, melody, or comping." onStep={(dir) => {
            const list = performances.length ? performances : performanceCatalog()
            const index = Math.max(0, list.findIndex((item) => item.id === state.performanceId))
            const next = list[cycle(index, dir, list.length)]
            patch({ performanceId: next.id, rate: next.rate, swing: next.swing })
          }} />
          <Stepper label="Expressions" value={EXPRESSIONS[expression]?.name ?? 'Still'} hint={EXPRESSIONS[expression]?.hint ?? 'Feel of the part.'} onStep={(dir) => setExpression(cycle(expression, dir, EXPRESSIONS.length))} />
          <Stepper label="Keys lock" value={KEYS_LOCK_LABELS[state.keysLock]} hint="Scale snap or hide, chord lock, chord notes, or one finger chords." onStep={(dir) => {
            const next = KEYS_LOCKS[cycle(lockIndex, dir, KEYS_LOCKS.length)]
            patch({ keysLock: next, snap: next !== 'off' })
          }} />
          <Stepper label="Voice grouping" value={voiceLabel} hint="How the chord is stacked, or only the bass or upper notes." onStep={(dir) => {
            const index = Math.max(0, VOICE_GROUPS.findIndex((item) => item.label === voiceLabel))
            const next = VOICE_GROUPS[cycle(index, dir, VOICE_GROUPS.length)]
            patch({ voiceGroup: next.id, ...(next.voicing ? { voicing: next.voicing } : {}), voiceLead: next.id === 'dynamic' ? true : state.voiceLead })
          }} />
          <Stepper label="Humanize" value={HUMAN[human]} hint="Move timing and velocity a little, so the chord is not a machine." onStep={(dir) => setHuman(cycle(human, dir, HUMAN.length))} />
          <Stepper label="Rate" value={RATE_LABEL[rateIndex]} hint="How fast the performance steps." onStep={(dir) => patch({ rate: RATES[cycle(rateIndex, dir, RATES.length)] })} />
          <Stepper label="Swing" value={SWING_LABEL[swingIndex]} hint="Delay the offbeats." onStep={(dir) => patch({ swing: SWINGS[cycle(swingIndex, dir, SWINGS.length)] })} />
          <Stepper label="Arpeggio" value={state.arp === 'off' ? 'Off' : state.arp === 'upDown' ? 'Up down' : state.arp[0].toUpperCase() + state.arp.slice(1)} hint="Break the chord into single notes when no performance is chosen." onStep={(dir) => patch({ arp: ARPS[cycle(Math.max(0, ARPS.indexOf(state.arp)), dir, ARPS.length)], performanceId: '' })} />
          <Stepper label="Gate" value={`${Math.round(GATES[gateIndex] * 100)} percent`} hint="How long each note holds." onStep={(dir) => patch({ gate: GATES[cycle(gateIndex, dir, GATES.length)] })} />
        </div>
        <div className="scaler-sound">
          <Stepper label="Sound" value={sound.label} hint={sound.hint} onStep={(dir) => {
            const index = Math.max(0, SOUNDS.findIndex((item) => item.id === state.sound))
            const next = SOUNDS[cycle(index, dir, SOUNDS.length)]
            patch({ sound: next.id })
            if (next.id === 'library' || next.id === 'forward') setOptions(true)
          }} />
          <div className="scaler-sounds" role="group" aria-label="Sound. Which instrument plays the chords.">
            {SOUNDS.map((item) => (
              <button key={item.id} type="button" className={state.sound === item.id ? 'on' : ''} aria-pressed={state.sound === item.id} title={item.hint} onClick={() => {
                patch({ sound: item.id })
                if (item.id === 'library' || item.id === 'forward') setOptions(true)
              }}>{item.label}</button>
            ))}
          </div>
          {state.sound === 'forward' && (
            <div className="scaler-forward">
              {store.project.tracks.filter((item) => item.type === 'midi' && item.id !== trackId).map((item) => (
                <button key={item.id} type="button" className={state.forwardTrackId === item.id ? 'on' : ''} onClick={() => patch({ forwardTrackId: item.id })}>{item.name}</button>
              ))}
              {!store.project.tracks.some((item) => item.type === 'midi' && item.id !== trackId) && <p className="scaler-hint">Add another MIDI track to send the chords there.</p>}
            </div>
          )}
          {state.sound === 'library' && <LibraryPanel store={store} engine={engine} trackId={trackId} />}
        </div>

        <div className="scaler-browser">
          <button type="button" title={state.input === 'audio' ? 'Guess the key from audio on this project.' : 'Guess the key from the MIDI on this track.'} onClick={() => {
            if (state.input === 'audio') {
              const heard = store.detectScalerAudio(trackId)
              if (!heard) setHint('Record or import audio first. Detect reads a clip on an audio track.')
              else {
                setAudioHeard(heard.chords)
                setHint(heard.chords.length ? `Detected a key from the audio. Chords ${heard.chords.join(', ')}.` : 'Detected a key from the audio.')
              }
              return
            }
            if (!store.detectScaler(trackId)) setHint('Draw or record a few notes first. Detect reads the MIDI on this track.')
            else setHint(midiChords.length ? `Detected a key from the notes on this track. Chords ${midiChords.join(', ')}.` : 'Detected a key from the notes on this track.')
          }}>Detect</button>
          <button type="button" title="Browse scales inside the plugin." onClick={() => setFamily('all')}>Scales</button>
          <Stepper label="Songs" value={activeSet?.name ?? 'Song'} hint={activeSet ? `${activeSet.style}. ${activeSet.name}.` : 'A set of progressions.'} onStep={(dir) => {
            const next = cycle(song, dir, sets.length)
            setSong(next)
            const chosen = library.find((item) => item.id === sets[next]?.progressionIds[0])
            if (chosen) loadProgression(chosen)
          }} />
          <Stepper label="Chord set" value={GROUPS.find((item) => item.id === state.group)?.label ?? 'Triads'} hint="Which chords the pads show." onStep={(dir) => {
            const index = Math.max(0, GROUPS.findIndex((item) => item.id === state.group))
            setPad(0)
            patch({ group: GROUPS[cycle(index, dir, GROUPS.length)].id, inversion: 0, lastVoicing: [], lastCents: [] })
          }} />
          <button type="button" className={family === 'western' ? 'on' : ''} title="Western scales in the library." onClick={() => setFamily(family === 'western' ? 'all' : 'western')}>User</button>
          <span className={`mood-pill ${laneMood.feel.toLowerCase()}`} title="Whether this progression feels bright and lifting or dark and tense.">{laneMood.feel}</span>
        </div>
        <div className="scaler-families" role="group" aria-label="Genres">
          <button type="button" className={genre === 'all' ? 'on' : ''} onClick={() => { setGenre('all'); setSong(0) }}>All genres</button>
          {GENRE_INFO.map((item) => (
            <button key={item.id} type="button" className={genre === item.id ? 'on' : ''} onClick={() => { setGenre(item.id); setSong(0) }}>{item.name}</button>
          ))}
        </div>
        <div className="scaler-families" role="group" aria-label="Performances">
          {['Arpeggio', 'Strum', 'Rhythm', 'Bassline', 'Melody', 'Comping'].map((item) => (
            <button key={item} type="button" className={category === item ? 'on' : ''} onClick={() => setCategory(item)}>{item}</button>
          ))}
        </div>
        <div className="scaler-pads" role="group" aria-label="Song progressions">
          {songLines.filter((item) => !songQuery || `${item.name} ${item.description}`.toLowerCase().includes(songQuery.toLowerCase())).slice(0, 8).map((item) => (
            <button key={item.id} type="button" className="scaler-card" title={item.description} onClick={() => loadProgression(item)}>
              <i className="bar" data-mood={moodOf(item.name, scaleId).word} />
              <b>{item.name}</b>
              <span>{item.genre}</span>
            </button>
          ))}
        </div>

        <div className="scaler-transport">
          <Stepper label="Transpose" value={String(st)} hint="Transpose the chords, in semitones." onStep={(dir) => { if (!locked) setSt(clamp(st + dir, -12, 12)) }} />
          <button type="button" className={locked ? 'on' : ''} aria-pressed={locked} title="Lock the key, the chord set, and transpose." onClick={() => setLocked((value) => !value)}>{locked ? 'Locked' : 'Lock'}</button>
          <input aria-label="Search songs" title="Find a progression by name." placeholder="Search songs" value={songQuery} onChange={(event) => setSongQuery(event.target.value)} />
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

        <section className="scaler-fold">
          <h2>Detected scales</h2>
          <p className="scaler-hint">{(state.input === 'audio' ? audioHeard : midiChords).length ? `Detected chords ${(state.input === 'audio' ? audioHeard : midiChords).join(', ')}.` : 'Detected chords appear here after MIDI or audio comes in.'}</p>
          <div className="scaler-table" role="table" aria-label="Detected scales">
            <div className="head" role="row"><span>Scale</span><span>Notes</span><span>Chords</span><span>Style</span><span>Mode</span><span>Mood</span></div>
            {rows.map((row) => (
              <button key={`${row.root}-${row.scaleId}`} type="button" role="row" className={row.root === state.root && (row.scaleId === scaleId || row.scaleId === state.scale) ? 'on' : ''} onClick={() => {
                const chosen = pickScale(row.scaleId)
                patch({ root: row.root, ...chosen, lastVoicing: [], lastCents: [] })
                const scaleChord = harmonize(row.root, row.scaleId, 3)[0]
                if (scaleChord) hear(place(scaleChord.tones.map((tone, index) => ({ pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined, startBeat: index * 0.5, durationBeats: 0.45, velocity: 0.8 })), st, octave, human, expressionId))
              }}>
                <span>Hear {NOTE_NAMES[row.root]} {row.name}</span>
                <span>{row.spell} {row.notes}</span>
                <span>{row.chords}</span>
                <span>{row.style}</span>
                <span>{row.mode}</span>
                <span>{row.mood}</span>
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
        </section>

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
                    hear(place(chord.tones.map((tone) => ({ pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined, startBeat: 0, durationBeats: bar, velocity: 0.84 })), st, octave, human, expressionId))
                    if (edit) {
                      const notes = place(chord.tones.map((tone) => ({ pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined, startBeat: 0, durationBeats: bar, velocity: 0.84 })), st, octave, human, expressionId)
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
              <button
                key={part.id}
                type="button"
                className={section === index ? 'on' : ''}
                aria-pressed={section === index}
                draggable
                title={`Drag ${part.name} to arrange, or onto another section to reorder.`}
                onClick={() => { setSection(index); setSlot(0) }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(SECTION_MIME, String(index))
                  dragChord(event, notesFromSlots(part.slots, bar), part.name)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const from = Number(event.dataTransfer.getData(SECTION_MIME))
                  if (!Number.isInteger(from)) return
                  event.preventDefault()
                  setSections((prev) => moveItem(prev, from, index))
                  setSection(index)
                }}
              >{part.name}</button>
            ))}
            <button type="button" title="Add a section." onClick={() => setSections((prev) => prev.length >= 8 ? prev : [...prev, { id: `part-${prev.length}`, name: `Part ${prev.length}`, slots: blank() }])}>Add</button>
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
              <button type="button" className={rec || engine.status === 'recording' ? 'on' : ''} aria-pressed={rec} title="Record each pad as MIDI on this track." onClick={() => setRec((value) => !value)}>Record</button>
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
      <Piano start={48} end={72} scalePcs={scalePcs} chordPcs={chordPcs} mode={state.keysLock} onPlay={playKey} />
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

function Piano({ start, end, scalePcs, chordPcs, mode, onPlay }: { start: number; end: number; scalePcs: Set<number>; chordPcs: Set<number>; mode: KeysLock; onPlay: (midi: number) => void }) {
  const whites: number[] = []
  const blackAfter = new Map<number, number>()
  for (let midi = start; midi <= end; midi++) {
    if (WHITE.has(midi % 12)) whites.push(midi)
    else if (whites.length) blackAfter.set(whites[whites.length - 1], midi)
  }
  const hidden = (midi: number) => {
    const pc = midi % 12
    if (mode === 'scale-hide') return !scalePcs.has(pc)
    if (mode === 'chord-notes') return chordPcs.size > 0 && !chordPcs.has(pc)
    if (mode === 'chord') return !WHITE.has(pc)
    return false
  }
  const klass = (midi: number) => {
    const pc = midi % 12
    const hide = hidden(midi) ? ' hidden' : ''
    if (chordPcs.has(pc)) return `chord${hide}`
    if (scalePcs.has(pc)) return `scale${hide}`
    return hide.trim()
  }
  const label = (midi: number) => {
    const name = NOTE_NAMES[midi % 12]
    return midi % 12 === 0 ? `${name}${Math.floor(midi / 12) - 1}` : name
  }
  return (
    <div className="scaler-keys" style={{ ['--whites' as string]: whites.length }} aria-label="Keyboard. Amber keys are in the scale. Green keys are the chord." data-keyboard="scaler">
      <div className="scaler-keybed">
        {whites.map((midi) => {
          const black = blackAfter.get(midi)
          return (
            <div className="scaler-slot" key={midi}>
              <button type="button" className={`scaler-white ${klass(midi)}`} aria-label={label(midi)} aria-disabled={hidden(midi)} onClick={() => { if (!hidden(midi)) onPlay(midi) }}>
                <small>{label(midi)}</small>
              </button>
              {black != null && black <= end && (
                <button type="button" className={`scaler-black ${klass(black)}`} aria-label={KEY_WORD[black % 12]} aria-disabled={hidden(black)} onClick={() => { if (!hidden(black)) onPlay(black) }} />
              )}
            </div>
          )
        })}
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
          style={{ transform: `rotate(${index * 30}deg) translateY(-100px) rotate(${-index * 30}deg)` }}
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

function place(notes: ScalerNote[], semitones: number, octave: number, human: number, expression = 'still'): ScalerNote[] {
  const shifted = humanizeNotes(notes.map((note) => ({
    ...note,
    pitch: clamp(Math.round(note.pitch + semitones + octave * 12), 0, 127),
  })), human)
  return applyExpression(shifted, expression)
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
