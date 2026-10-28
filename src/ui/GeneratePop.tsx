import { useEffect } from 'react'
import type { AudioEngine } from '../audio/engine'
import { followSource, generate, generatorInput, styleById, STYLES } from '../generators'
import type { ArpPattern, GeneratorKind, StrumPattern } from '../generators'
import { NOTE_NAMES } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import { selectGenerator } from '../state/select'
import type { ProjectStore } from '../state/store'
import { getScale } from '../theory/scales'
import { useFormFactor } from './form'
import './generate.css'

const KINDS: { id: GeneratorKind; name: string; hint: string }[] = [
  { id: 'chords', name: 'Chords', hint: 'A progression in your key, as MIDI you can edit.' },
  { id: 'bass', name: 'Bass', hint: 'A bass line that follows the chords.' },
  { id: 'melody', name: 'Melody', hint: 'A tune on the chords, in the scale.' },
  { id: 'arp', name: 'Arp', hint: 'The chords, broken into a repeating pattern.' },
  { id: 'rhythm', name: 'Strum', hint: 'A rhythm pattern played on the chords.' },
  { id: 'drums', name: 'Drums', hint: 'A drum beat in the style you picked.' },
]

const ARPS: { id: ArpPattern; name: string }[] = [
  { id: 'up', name: 'Up' },
  { id: 'down', name: 'Down' },
  { id: 'upDown', name: 'Up/down' },
  { id: 'downUp', name: 'Down/up' },
  { id: 'inside', name: 'Inside' },
  { id: 'outside', name: 'Outside' },
  { id: 'broken', name: 'Broken' },
  { id: 'random', name: 'Random' },
]

const RATES: { beats: number; name: string }[] = [
  { beats: 1, name: '1/4' },
  { beats: 0.5, name: '1/8' },
  { beats: 1 / 3, name: '1/8T' },
  { beats: 0.25, name: '1/16' },
  { beats: 1 / 6, name: '1/16T' },
  { beats: 0.125, name: '1/32' },
]

const STRUMS: { id: StrumPattern; name: string }[] = [
  { id: 'block', name: 'Pads' },
  { id: 'down', name: 'Down' },
  { id: 'folk', name: 'Folk' },
  { id: 'skank', name: 'Skank' },
  { id: 'funk', name: 'Funk' },
  { id: 'disco', name: 'Disco' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'tresillo', name: 'Tresillo' },
  { id: 'rock', name: 'Rock' },
  { id: 'afro', name: 'Afro' },
  { id: 'gospel', name: 'Gospel' },
  { id: 'montuno', name: 'Montuno' },
]

const BARS = [1, 2, 4, 8, 16]

export function GeneratePanel({
  store,
  engine,
  trackId,
  scale,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId?: string
  scale?: { root: number; scale: string; library: string }
}) {
  const phone = useFormFactor() === 'phone'
  const view = selectGenerator(store)
  const settings = view.settings
  const song = view.scale
  const style = styleById(settings.style)
  const kind = KINDS.find((item) => item.id === settings.kind) ?? KINDS[0]
  const source = followSource(view.project)
  const made = generatorInput(view.project, settings, source.chords)
  const part = generate(settings.kind, scale ? { ...made, key: scale.root, scaleId: scale.library || scale.scale } : made)
  const keyRoot = scale?.root ?? song.root
  const keyName = getScale(scale?.library || scale?.scale || view.scaleId).name
  useEffect(() => () => engine.stopPreview(), [engine])
  useEffect(() => {
    if (settings.kind !== 'chords' && source.source !== 'none') return
    store.rememberChords(part.chords)
  })
  const follow = settings.kind === 'chords'
    ? 'Writes a new progression from your key and scale.'
    : source.source === 'track'
      ? 'Follows the chords on the Chords track.'
      : source.source === 'idea'
        ? 'Follows the chord idea you already picked.'
        : source.source === 'memory'
          ? 'Follows the progression you just made.'
          : 'No chords yet, so this writes a progression and follows it.'
  const hear = () => {
    engine.unlock()
    const beat = 60 / Math.max(40, view.tempo)
    engine.previewSequence(part.notes.slice(0, 480).map((note) => ({
      pitch: note.pitch,
      at: note.startBeat * beat,
      dur: Math.max(0.05, note.durationBeats * beat),
      velocity: note.velocity,
      drum: settings.kind === 'drums',
      cents: note.fine ?? 0,
    })))
  }
  const placeHere = () => {
    if (!trackId) return
    engine.stopPreview()
    const beat = Math.max(0, projectSampleBeat(view.project, engine.currentTimelineSample()))
    store.writeScalerClip(trackId, part.notes.map((note) => ({
      pitch: note.pitch,
      fine: note.fine,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
    })), beat, part.name)
  }
  return (
    <div className="gen-pop gen-embedded" data-generate="open" aria-label="Generate">
      <header>
        <strong>Generate</strong>
        <span className="gen-key">{NOTE_NAMES[keyRoot]} {keyName} · {Math.round(view.tempo)}</span>
      </header>
      <div className="gen-body">
        {phone ? (
          <select aria-label="Part. Chords, bass, melody, arp, strum, or drums." title={kind.hint} value={settings.kind} onChange={(event) => store.setGenerator({ kind: event.target.value as GeneratorKind })}>
            {KINDS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        ) : (
          <div className="gen-kinds" role="group" aria-label="Part">
            {KINDS.map((item) => (
              <button key={item.id} type="button" className={settings.kind === item.id ? 'on' : ''} aria-pressed={settings.kind === item.id} title={item.hint} onClick={() => store.setGenerator({ kind: item.id })}>
                {item.name}
              </button>
            ))}
          </div>
        )}
        <p className="gen-hint">{kind.hint}</p>
        {phone ? (
          <select
            aria-label="Style. Sets the groove and the kind of chords."
            title="Sets the groove and the kind of chords."
            value={settings.style}
            onChange={(event) => {
              const next = styleById(event.target.value)
              store.setGenerator({
                style: event.target.value,
                arpPattern: next.arp.pattern,
                rate: next.arp.rate,
                octaves: next.arp.octaves,
                gate: next.arp.gate,
                strum: next.strum,
              })
            }}
          >
            {STYLES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        ) : (
          <div className="chip-row" role="group" aria-label="Style">
            {STYLES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={settings.style === item.id ? 'on' : ''}
                aria-pressed={settings.style === item.id}
                title={item.blurb}
                onClick={() => {
                  const next = styleById(item.id)
                  store.setGenerator({
                    style: item.id,
                    arpPattern: next.arp.pattern,
                    rate: next.arp.rate,
                    octaves: next.arp.octaves,
                    gate: next.arp.gate,
                    strum: next.strum,
                  })
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
        <p className="gen-hint">{style.blurb} Sets the groove and the kind of chords.</p>
        {phone ? (
          <select aria-label="Bars. How many bars to write." title="How many bars to write." value={settings.bars} onChange={(event) => store.setGenerator({ bars: Number(event.target.value) })}>
            {BARS.map((bars) => <option key={bars} value={bars}>{bars}</option>)}
          </select>
        ) : (
          <div className="gen-step" role="group" aria-label="Bars">
            {BARS.map((bars) => (
              <button key={bars} type="button" className={settings.bars === bars ? 'on' : ''} aria-pressed={settings.bars === bars} onClick={() => store.setGenerator({ bars })}>{bars}</button>
            ))}
          </div>
        )}
        <p className="gen-hint">How many bars to write.</p>
        {settings.kind === 'arp' && (
          <>
            {phone ? (
              <select aria-label="Arp pattern. The order the chord notes play." title="The order the chord notes play." value={settings.arpPattern} onChange={(event) => store.setGenerator({ arpPattern: event.target.value as ArpPattern })}>
                {ARPS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            ) : (
              <div className="chip-row" role="group" aria-label="Arp pattern">
                {ARPS.map((item) => (
                  <button key={item.id} type="button" className={settings.arpPattern === item.id ? 'on' : ''} aria-pressed={settings.arpPattern === item.id} onClick={() => store.setGenerator({ arpPattern: item.id })}>{item.name}</button>
                ))}
              </div>
            )}
            <p className="gen-hint">The order the chord notes play.</p>
            <div className="chip-row" role="group" aria-label="Arp rate">
              {RATES.map((item) => (
                <button key={item.name} type="button" className={Math.abs(settings.rate - item.beats) < 0.001 ? 'on' : ''} aria-pressed={Math.abs(settings.rate - item.beats) < 0.001} onClick={() => store.setGenerator({ rate: item.beats })}>{item.name}</button>
              ))}
            </div>
            <p className="gen-hint">How fast each arp step is.</p>
            <div className="gen-step" role="group" aria-label="Octave range">
              {[1, 2, 3].map((octaves) => (
                <button key={octaves} type="button" className={settings.octaves === octaves ? 'on' : ''} aria-pressed={settings.octaves === octaves} onClick={() => store.setGenerator({ octaves })}>{octaves}</button>
              ))}
            </div>
            <p className="gen-hint">How many octaves the arp climbs.</p>
            <label className="gen-gate">
              Gate
              <input
                aria-label="Gate"
                type="range"
                min={0.15}
                max={1}
                step={0.05}
                value={settings.gate}
                onChange={(event) => store.setGenerator({ gate: Number(event.target.value) }, true)}
                onPointerUp={() => store.endDraft()}
                onPointerCancel={() => store.endDraft()}
              />
            </label>
            <p className="gen-hint">How long each arp note holds. Short is staccato, long is legato.</p>
          </>
        )}
        {settings.kind === 'rhythm' && (
          <>
            {phone ? (
              <select aria-label="Strum pattern. The rhythm played on the chords." title="The rhythm played on the chords." value={settings.strum} onChange={(event) => store.setGenerator({ strum: event.target.value as StrumPattern })}>
                {STRUMS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            ) : (
              <div className="chip-row" role="group" aria-label="Strum pattern">
                {STRUMS.map((item) => (
                  <button key={item.id} type="button" className={settings.strum === item.id ? 'on' : ''} aria-pressed={settings.strum === item.id} onClick={() => store.setGenerator({ strum: item.id })}>{item.name}</button>
                ))}
              </div>
            )}
            <p className="gen-hint">The strum or stab rhythm played on the chords.</p>
          </>
        )}
        <p className="gen-follow">{follow}</p>
        {part.label && <p className="gen-chords">{part.label}</p>}
        <p className="gen-hint">Seed {settings.seed}{settings.variation ? ` · vary ${settings.variation}` : ''}. Hear it before it lands on a track.</p>
        <div className="gen-actions">
          <button type="button" onClick={hear}>Hear</button>
          <button type="button" onClick={() => store.setGenerator({ seed: Math.floor(Math.random() * 0x7fffffff), variation: 0 })}>New</button>
          <button type="button" onClick={() => store.setGenerator({ variation: settings.variation + 1 })}>Vary</button>
          {trackId && <button type="button" title="Put this MIDI on the Scaler track." onClick={placeHere}>This track</button>}
          {!phone && <button type="button" onClick={() => { engine.stopPreview(); store.insertGenerated(part, 'part') }}>Add to {part.trackName}</button>}
          {!phone && <button type="button" className="wide" onClick={() => { engine.stopPreview(); store.insertGenerated(part, 'new') }}>New track</button>}
        </div>
        <p className="gen-hint">Hear plays it. New picks another seed. Vary changes this idea a little. Add puts editable MIDI on the {part.trackName} track. New track starts a fresh one.</p>
      </div>
    </div>
  )
}
