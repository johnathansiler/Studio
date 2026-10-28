import { useEffect, useState, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { SCALER_MIME, activeScaleId, chooseScale as pickScale, encodeScalerDrag, normalizeScaler, padPerformance, progressionPerformance, scalerChords } from '../instruments/scaler/model'
import { SCALER_PAGES, type ScalerGroup, type ScalerNote, type ScalerPage, type ScalerSound } from '../instruments/scaler/types'
import { NOTE_NAMES, SCALES } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import {
  allScales,
  getScale,
  loadScaleCatalog,
  progressionsFor,
  scaleFamilies,
  spellScale,
  toneName,
  VOICINGS,
  type VoicingId,
} from '../theory'
import { GeneratePanel } from './GeneratePop'
import { useFormFactor } from './form'
import { LibraryPanel } from './LibraryPanel'
import './scaler.css'

const GROUPS: { id: ScalerGroup; label: string; hint: string }[] = [
  { id: 'triad', label: 'Triads', hint: 'Three-note chords on each scale degree.' },
  { id: 'seventh', label: '7ths', hint: 'Four-note chords.' },
  { id: 'ninth', label: '9ths', hint: 'Sevenths plus the ninth.' },
  { id: 'sus', label: 'Sus', hint: 'Suspended chords that fit this scale.' },
  { id: 'add', label: 'Add', hint: 'Added tones on a triad.' },
  { id: 'altered', label: 'Altered', hint: 'Flat and sharp fifths and ninths inside the scale.' },
]

const SOUNDS: { id: ScalerSound; label: string; hint: string }[] = [
  { id: 'synth', label: 'Synth', hint: 'Play through this track’s synth.' },
  { id: 'sampler', label: 'Sampler', hint: 'Play through this track’s sampler.' },
  { id: '808', label: '808', hint: 'Play the chords with the 808.' },
  { id: 'drum-machine', label: 'Drums', hint: 'Play the chords as drum hits.' },
  { id: 'library', label: 'Library', hint: 'Play a multi-sample instrument from the free library.' },
  { id: 'forward', label: 'Track', hint: 'Send the MIDI to another instrument track.' },
]

const ARPS = [
  { id: 'off', label: 'Off' },
  { id: 'up', label: 'Up' },
  { id: 'down', label: 'Down' },
  { id: 'upDown', label: 'Up/down' },
  { id: 'random', label: 'Random' },
] as const

const RHYTHMS = [
  { id: 'block', label: 'Block' },
  { id: 'quarter', label: 'Quarters' },
  { id: 'eighth', label: 'Eighths' },
  { id: 'sync', label: 'Sync' },
  { id: 'strum', label: 'Strum' },
] as const

const RATES = [
  { beats: 2, label: '1/2' },
  { beats: 1, label: '1/4' },
  { beats: 0.5, label: '1/8' },
  { beats: 0.25, label: '1/16' },
  { beats: 0.125, label: '1/32' },
]

export function ScalerPanel({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const phone = useFormFactor() === 'phone'
  const [rec, setRec] = useState(false)
  const [pad, setPad] = useState(0)
  const [line, setLine] = useState('')
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState('all')
  const [, setCatalog] = useState(0)
  const [hint, setHint] = useState('Pads play the chords in this key.')
  useEffect(() => {
    let alive = true
    void loadScaleCatalog().then(() => {
      if (alive) setCatalog((value) => value + 1)
    })
    return () => {
      alive = false
    }
  }, [])

  const track = store.track(trackId)
  if (!track || track.type !== 'midi') return null
  const clips = track.midiClips
  const state = normalizeScaler(track.scaler)
  const page = store.scalerPage
  const scaleId = activeScaleId(state)
  const scaleName = getScale(scaleId).name
  const chords = scalerChords(state)
  const bar = Math.max(1, store.project.timeSignature?.numerator || 4)
  const lines = progressionsFor(scaleId)
  const chosenLine = lines.find((item) => item.id === line) ?? lines[0]
  const degrees = spellScale(state.root, scaleId, 3)
  const families = scaleFamilies()
  const scales = allScales().filter((item) => {
    if (family !== 'all' && item.family !== family) return false
    const text = query.trim().toLowerCase()
    if (!text) return true
    return `${item.name} ${item.description} ${item.family}`.toLowerCase().includes(text)
  })
  function patch(next: Parameters<ProjectStore['setScaler']>[1]) {
    store.setScaler(trackId, next)
    const merged = normalizeScaler({ ...state, ...next })
    if (!merged.snap) return
    store.setScale({
      root: merged.root,
      scale: merged.scale,
      library: merged.library,
      snap: true,
      voicing: merged.voicing,
      inversion: merged.inversion,
      voiceLead: merged.voiceLead,
      arp: merged.arp,
      rate: merged.rate,
      gate: merged.gate,
      octaves: merged.octaves,
      rhythm: merged.rhythm,
    })
  }

  function hear(notes: ScalerNote[], voiced?: { midi: number; cents: number }[]) {
    engine.unlock()
    const beatSec = 60 / Math.max(40, store.project.tempo)
    engine.auditionScaler(trackId, notes.map((note) => ({
      pitch: note.pitch,
      fine: note.fine,
      delay: note.startBeat * beatSec,
      duration: Math.max(0.05, note.durationBeats * beatSec),
      velocity: note.velocity,
    })))
    if (voiced?.length) store.rememberScalerVoice(trackId, voiced.map((tone) => tone.midi), voiced.map((tone) => tone.cents))
  }

  function atBeat(live: boolean) {
    const sample = engine.currentTimelineSample()
    const beat = Math.max(0, projectSampleBeat(store.project, sample))
    const moving = engine.status === 'playing' || engine.status === 'recording'
    if (live && moving) return beat
    if (live) {
      const take = clips.find((clip) => clip.name === 'Scaler')
      if (take) return take.startBeat + take.durationBeats
    }
    if (store.project.snap) return Math.floor(beat / bar) * bar
    return Math.floor(beat * 4) / 4
  }

  function playPad(index: number, write: boolean) {
    const played = padPerformance(state, index, bar)
    if (!played) return
    setPad(index)
    setHint(`${played.symbol}. ${played.roman}.`)
    hear(played.notes, played.voiced)
    const capture = write || rec || engine.status === 'recording'
    if (!capture) return
    if (write && !rec && engine.status !== 'recording') store.writeScalerClip(trackId, played.notes, atBeat(false), played.symbol)
    else store.recordScalerChord(trackId, played.notes, atBeat(true))
  }

  function playLine(id: string, write: boolean) {
    const played = progressionPerformance(state, id, bar)
    if (!played) return
    setLine(id)
    setHint(played.symbols.join(' '))
    hear(played.notes, played.voiced)
    if (write || rec || engine.status === 'recording') store.writeScalerClip(trackId, played.notes, atBeat(false), played.name)
  }

  function dragPad(event: DragEvent, index: number) {
    const played = padPerformance(state, index, bar)
    if (!played) return
    const raw = encodeScalerDrag({ trackId, name: played.symbol, notes: played.notes })
    event.dataTransfer.setData(SCALER_MIME, raw)
    event.dataTransfer.setData('text/plain', raw)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className={`scaler-panel ${phone ? 'phone' : ''}`} data-scaler="plugin" data-page={page} aria-label="Scaler">
      <header>
        <strong>Scaler</strong>
        <span className="scaler-key">{NOTE_NAMES[state.root]} {scaleName}</span>
        {phone ? (
          <select
            aria-label="Scaler page. Play, key, voice, sound, or write."
            title="Which part of Scaler is open."
            value={page}
            onChange={(event) => store.setScalerPage(event.target.value as ScalerPage)}
          >
            {SCALER_PAGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        ) : (
          <div className="scaler-pages" role="group" aria-label="Scaler pages">
            {SCALER_PAGES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={page === item.id ? 'on' : ''}
                aria-pressed={page === item.id}
                title={item.hint}
                onClick={() => store.setScalerPage(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="text-btn" title="Close Scaler. The track keeps the instrument." aria-label="Close Scaler. The track keeps the instrument." onClick={() => store.openScaler(trackId)}>×</button>
      </header>
      <p className="scaler-hint">{hint}</p>
      <div className="scaler-body">
        {page === 'play' && (
          <>
            {phone ? (
              <select aria-label="Chord set." title="Which chords the pads show." value={state.group} onChange={(event) => patch({ group: event.target.value as ScalerGroup, lastVoicing: [], lastCents: [] })}>
                {GROUPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            ) : (
              <div className="chip-row" role="group" aria-label="Chord set">
                {GROUPS.map((item) => (
                  <button key={item.id} type="button" className={state.group === item.id ? 'on' : ''} aria-pressed={state.group === item.id} title={item.hint} onClick={() => patch({ group: item.id, lastVoicing: [], lastCents: [] })}>{item.label}</button>
                ))}
              </div>
            )}
            <div className="scaler-pads" role="group" aria-label="Chord pads">
              {chords.map((chord, index) => (
                <button
                  key={`${chord.symbol}-${index}`}
                  type="button"
                  className={pad === index ? 'on' : ''}
                  aria-pressed={pad === index}
                  draggable
                  title={`Hear ${chord.symbol}. ${chord.roman}. Drag it onto a track, or turn Rec on to record it.`}
                  aria-label={`${chord.symbol}. ${chord.roman}.`}
                  onDragStart={(event) => dragPad(event, index)}
                  onClick={() => playPad(index, false)}
                >
                  <b>{chord.symbol}</b>
                  <span>{chord.roman}</span>
                </button>
              ))}
              {!chords.length && <p className="scaler-hint">No chords of this kind sit inside the scale.</p>}
            </div>
            <div className="scaler-actions">
              <button type="button" className={rec || engine.status === 'recording' ? 'on' : ''} aria-pressed={rec || engine.status === 'recording'} title="Record each pad as MIDI on this track." onClick={() => setRec((value) => !value)}>Rec</button>
              <button type="button" title="Put the selected chord on the timeline as MIDI." onClick={() => playPad(pad, true)}>To track</button>
            </div>
            {phone ? (
              <select aria-label="Progression." title="A common progression in this key." value={chosenLine?.id ?? ''} onChange={(event) => { setLine(event.target.value); playLine(event.target.value, false) }}>
                {lines.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            ) : (
              <div className="scaler-lines" role="group" aria-label="Progressions">
                {lines.map((item) => (
                  <button key={item.id} type="button" className={chosenLine?.id === item.id ? 'on' : ''} aria-pressed={chosenLine?.id === item.id} title={item.description} onClick={() => playLine(item.id, false)}>
                    <b>{item.name}</b>
                    <span>{item.description}</span>
                  </button>
                ))}
              </div>
            )}
            {chosenLine && <button type="button" title="Put this progression on the timeline as MIDI." onClick={() => playLine(chosenLine.id, true)}>Progression</button>}
          </>
        )}
        {page === 'key' && (
          <>
            <div className="scaler-row">
              <select aria-label="Key. Concert pitch of the tonic." title="Concert pitch of the tonic." value={state.root} onChange={(event) => patch({ root: Number(event.target.value), lastVoicing: [], lastCents: [] })}>
                {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
              <select aria-label="Scale." title="Which notes are in key." value={state.scale} onChange={(event) => patch({ ...pickScale(event.target.value), lastVoicing: [], lastCents: [] })}>
                {SCALES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <button type="button" title="Guess the key from the MIDI on this track." onClick={() => {
                if (!store.detectScaler(trackId)) setHint('Draw or record a few notes first. Detect reads the MIDI on this track.')
                else setHint('Key locked from the notes on this track.')
              }}>Detect</button>
              <button type="button" className={state.snap ? 'on' : ''} aria-pressed={state.snap} title="Lock new piano-roll notes to this scale." onClick={() => patch({ snap: !state.snap })}>{state.snap ? 'Locked' : 'Lock'}</button>
            </div>
            <p className="scaler-hint">{getScale(scaleId).description}</p>
            <div className="scaler-row">
              <select aria-label="Tradition." title="Filter scales by tradition." value={family} onChange={(event) => setFamily(event.target.value)}>
                <option value="all">All</option>
                {families.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <input aria-label="Search scales" title="Find a scale by name." placeholder="Search scales" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            {(!phone || query || family !== 'all') && (
              <div className="scaler-scales" aria-label="Scales">
                {scales.slice(0, 80).map((item) => (
                  <button key={item.id} type="button" className={item.id === scaleId ? 'on' : ''} title={item.description} onClick={() => patch({ ...pickScale(item.id), lastVoicing: [], lastCents: [] })}>
                    <b>{item.name}</b>
                    <span>{item.description}</span>
                  </button>
                ))}
                {!scales.length && <p className="scaler-hint">No scales match.</p>}
              </div>
            )}
          </>
        )}
        {page === 'voice' && (
          <>
            <div className="scaler-row">
              <select aria-label="Voicing. How the chord is stacked." title={VOICINGS.find((item) => item.id === state.voicing)?.description ?? 'How the chord is stacked.'} value={state.voicing} onChange={(event) => patch({ voicing: event.target.value as VoicingId })}>
                {VOICINGS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <select aria-label="Inversion. Which chord tone sits lowest." title="Which chord tone sits lowest." value={state.inversion} onChange={(event) => patch({ inversion: Number(event.target.value) })}>
                {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value === 0 ? 'Root' : `Inversion ${value}`}</option>)}
              </select>
              <select aria-label="Bass. Keep the root, or choose another scale tone." title="Keep the root, or choose another scale tone." value={state.bassDegree == null ? '' : String(state.bassDegree)} onChange={(event) => patch({ bassDegree: event.target.value === '' ? null : Number(event.target.value) })}>
                <option value="">Bass: root</option>
                {degrees.map((tone, index) => <option key={`${tone.midi}-${index}`} value={index}>{toneName(tone)}</option>)}
              </select>
              <button type="button" className={state.voiceLead ? 'on' : ''} aria-pressed={state.voiceLead} title="Move each chord as little as possible from the one before it." onClick={() => patch({ voiceLead: !state.voiceLead })}>Lead</button>
            </div>
            <div className="scaler-row">
              <select aria-label="Arpeggio." title="Break the chord into single notes." value={state.arp} onChange={(event) => patch({ arp: event.target.value as typeof state.arp })}>
                {ARPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <select aria-label="Rate." title="How fast each arp step is." value={String(state.rate)} onChange={(event) => patch({ rate: Number(event.target.value) })}>
                {RATES.map((item) => <option key={item.label} value={item.beats}>{item.label}</option>)}
              </select>
              <select aria-label="Rhythm." title="Block chord, pulse, or strum." value={state.rhythm} onChange={(event) => patch({ rhythm: event.target.value as typeof state.rhythm })}>
                {RHYTHMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <select aria-label="Octaves." title="How many octaves the arp climbs." value={state.octaves} onChange={(event) => patch({ octaves: Number(event.target.value) })}>
                {[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <label className="scaler-gate">
              Gate
              <input
                aria-label="Gate. How long each note holds."
                title="How long each note holds."
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={state.gate}
                onChange={(event) => store.setScaler(trackId, { gate: Number(event.target.value) }, true)}
                onPointerUp={() => store.endDraft()}
                onPointerCancel={() => store.endDraft()}
              />
            </label>
          </>
        )}
        {page === 'sound' && (
          <>
            {phone ? (
              <select aria-label="Sound. Which instrument plays the chords." title="Which instrument plays the chords." value={state.sound} onChange={(event) => patch({ sound: event.target.value as ScalerSound })}>
                {SOUNDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            ) : (
              <div className="chip-row" role="group" aria-label="Sound">
                {SOUNDS.map((item) => (
                  <button key={item.id} type="button" className={state.sound === item.id ? 'on' : ''} aria-pressed={state.sound === item.id} title={item.hint} onClick={() => patch({ sound: item.id })}>{item.label}</button>
                ))}
              </div>
            )}
            <p className="scaler-hint">{SOUNDS.find((item) => item.id === state.sound)?.hint}</p>
            {state.sound === 'forward' && (
              <select aria-label="Forward to. The other instrument that plays these chords." title="The other instrument that plays these chords." value={state.forwardTrackId} onChange={(event) => patch({ forwardTrackId: event.target.value })}>
                <option value="">Choose a track</option>
                {store.project.tracks.filter((item) => item.type === 'midi' && item.id !== trackId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            )}
            {state.sound === 'library' && <LibraryPanel store={store} engine={engine} trackId={trackId} />}
          </>
        )}
        {page === 'write' && (
          <GeneratePanel store={store} engine={engine} trackId={trackId} scale={{ root: state.root, scale: state.scale, library: state.library }} />
        )}
      </div>
    </div>
  )
}
