import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  KEYBOARD_END,
  KEYBOARD_START,
  TUNE_NAME,
  TUNE_PRESET_META,
  TUNE_RANGES,
  activeNoteMask,
  bitOn,
  blobMidi,
  dragNudge,
  graphNotes,
  heardPitchClass,
  nudgeKey,
  isBlackKey,
  nextScaleMask,
  readMeter,
  tuneOnTrack,
} from '../audio/plugins/autoTune'
import { NOTE_NAMES, SCALES } from '../model/scale'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'
import './autoTune.css'

export function addOrOpenAutoTune(store: ProjectStore, trackId: string) {
  const existing = tuneOnTrack(store.track(trackId)?.plugins ?? [])
  if (existing) {
    store.focusPlugin(trackId, existing.id)
    return
  }
  store.addPlugin(trackId, 'tune')
  const added = tuneOnTrack(store.track(trackId)?.plugins ?? [])
  if (added) store.focusPlugin(trackId, added.id)
}

export function AutoTuneTrackButton({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const plugin = tuneOnTrack(store.track(trackId)?.plugins ?? [])
  const hint = plugin ? 'Open Auto-Tune on this track.' : 'Add Auto-Tune. Starts in key and audible.'
  return (
    <TipButton
      className={`autotune-add ${plugin ? 'inserted' : ''} ${plugin?.enabled ? 'on' : ''}`}
      label="Auto-Tune"
      hint={hint}
      pressed={!!plugin?.enabled}
      onClick={(event) => {
        event.stopPropagation()
        addOrOpenAutoTune(store, trackId)
      }}
    >
      Auto-Tune
    </TipButton>
  )
}

export function AutoTuneLaneMark({ plugins }: { plugins: readonly { id: string; pluginId: string; enabled: boolean }[] }) {
  const plugin = tuneOnTrack(plugins)
  if (!plugin) return null
  return (
    <em className={`lane-insert ${plugin.enabled ? 'on' : ''}`} data-insert="tune">
      {plugin.enabled ? 'Auto-Tune' : 'Auto-Tune bypassed'}
    </em>
  )
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]

export function AutoTuneFace({
  values,
  trace,
  revision,
  enabled,
  projectKey,
  projectScale,
  projectRoot = 0,
  projectIntervals = MAJOR,
  active,
  presets,
  onChange,
  onPatch,
  onPreset,
  onBypass,
  onSave,
}: {
  values: Record<string, number>
  trace: Float32Array | null
  revision: number
  enabled: boolean
  projectKey: string
  projectScale: string
  projectRoot?: number
  projectIntervals?: readonly number[]
  active?: string | null
  presets?: readonly string[]
  onChange: (id: string, value: number) => void
  onPatch?: (patch: Record<string, number>) => void
  onPreset: (name: string) => void
  onBypass: () => void
  onSave?: (name: string) => void
}) {
  const [view, setView] = useState<'pitch' | 'graph'>('pitch')
  const [tool, setTool] = useState<'remove' | 'bypass'>('remove')
  const [latch, setLatch] = useState(true)
  const [more, setMore] = useState(false)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const a4 = values.a4 || 440
  const shownTrace = enabled && (values.amount ?? 0) > 0.001 ? trace : null
  const blobs = graphNotes(shownTrace, a4)
  const notes = useRef(blobs)
  notes.current = blobs
  const drag = useRef<{ startMidi: number; startCents: number; pc: number } | null>(null)
  const moment = useRef<Record<string, number> | null>(null)
  const meter = readMeter(shownTrace, a4)
  const mask = activeNoteMask(values, projectRoot, projectIntervals)
  const derived = activeNoteMask({ ...values, custom: 0, mask: 0 }, projectRoot, projectIntervals)
  const names = presets?.length ? [...presets] : TUNE_PRESET_META.map((item) => item.name)
  const presetAt = active && names.includes(active) ? names.indexOf(active) : -1
  const scaleLabel = scaleText(values, projectScale)
  const keyLabel = (values.root ?? -1) < 0 ? `Project · ${projectKey}` : NOTE_NAMES[Math.round(values.root)] ?? projectKey
  const rangeAt = nearestRange(values.minHz ?? 80, values.maxHz ?? 1000)

  useEffect(() => {
    drawGraph(canvas.current, shownTrace, values)
  }, [shownTrace, revision, values, view])

  const set = (id: string, value: number) => onChange(id, value)
  const patch = (next: Record<string, number>) => {
    if (onPatch) onPatch(next)
    else for (const [id, value] of Object.entries(next)) onChange(id, value)
  }

  const editNote = (pc: number, down: boolean) => {
    if (!latch) {
      if (down) {
        if (tool === 'bypass') {
          const stored = Math.round(values.bypassMask || 0)
          moment.current = { bypassMask: stored }
          set('bypassMask', (stored | (1 << pc)) & 4095)
        } else {
          const stored = Math.round(values.mask || 0)
          const custom = (values.custom ?? 0) >= 0.5
          moment.current = { custom: custom ? 1 : 0, mask: stored }
          patch({ custom: 1, mask: nextScaleMask(stored, custom, derived, pc) })
        }
        return
      }
      if (moment.current) {
        patch(moment.current)
        moment.current = null
      }
      return
    }
    if (tool === 'bypass') {
      set('bypassMask', toggleBitLocal(Math.round(values.bypassMask || 0), pc))
      return
    }
    const stored = Math.round(values.mask || 0)
    const custom = (values.custom ?? 0) >= 0.5
    patch({ custom: 1, mask: nextScaleMask(stored, custom, derived, pc) })
  }

  const toolHint = tool === 'remove'
    ? 'Remove: tap a note to drop it from the scale.'
    : 'Bypass: tap a note to let it through uncorrected.'

  return (
    <section className={`tune-board ${more ? 'show-more' : ''} ${view}`} aria-label={`${TUNE_NAME} faceplate`}>
      <header className="tune-top">
        <div className="tune-tabs" role="group" aria-label="Plugin view">
          <button type="button" className={view === 'pitch' ? 'on' : ''} aria-pressed={view === 'pitch'} title="Meter, knobs, and the scale keyboard." aria-label="Pitch. Meter, knobs, and the scale keyboard." onClick={() => setView('pitch')}>Pitch</button>
          <button type="button" className={view === 'graph' ? 'on' : ''} aria-pressed={view === 'graph'} title="Notes on a pitch grid. Drag a note to retune it." aria-label="Graph. Notes on a pitch grid. Drag a note to retune it." onClick={() => setView('graph')}>Graph</button>
        </div>
        <Stepper
          label="Preset"
          hint="Previous or next preset."
          value={presetAt < 0 ? 'Custom' : names[presetAt]}
          preset={presetAt < 0 ? undefined : names[presetAt]}
          onPrev={() => onPreset(names[presetAt < 0 ? names.length - 1 : (presetAt - 1 + names.length) % names.length])}
          onNext={() => onPreset(names[presetAt < 0 ? 0 : (presetAt + 1) % names.length])}
        />
        <div className="tune-actions">
          {naming ? (
            <input
              className="tune-name"
              aria-label="Preset name. Type a name and press enter."
              title="Name this preset."
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.trim()) {
                  onSave?.(draft.trim())
                  setNaming(false)
                }
                if (event.key === 'Escape') setNaming(false)
              }}
            />
          ) : null}
          <button type="button" title="Save these settings under a name." aria-label="Save preset. Keep these settings under a name." onClick={() => { setDraft(active ?? ''); setNaming((open) => !open) }}>Save</button>
          <button type="button" className={enabled ? '' : 'on'} aria-pressed={!enabled} title={enabled ? 'Bypass the whole plugin.' : 'Turn correction back on.'} aria-label={enabled ? 'Bypass. Turn correction off.' : 'Bypassed. Turn correction on.'} onClick={onBypass}>{enabled ? 'Bypass' : 'Bypassed'}</button>
          <button type="button" className={`more ${more ? 'on' : ''}`} aria-pressed={more} title="Show the rest of the controls." aria-label="More. Show flex, vibrato, reference, and tone." onClick={() => setMore((open) => !open)}>More</button>
        </div>
      </header>

      <div className="tune-status" data-tool={tool}>
        <i />
        <span>{tool === 'remove' ? 'Remove is on. Tap a note to drop it.' : 'Bypass is on. Tap a note to let it through.'} {latch ? 'Latch.' : 'Momentary.'}</span>
      </div>

      {view === 'pitch' ? (
        <div className="tune-stage">
          <PitchMeter meter={meter} held={Math.round(values.holdMidi ?? -1) >= 0} onHold={() => {
            if (Math.round(values.holdMidi ?? -1) >= 0) set('holdMidi', -1)
            else if (meter) set('holdMidi', Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(meter.hz / a4)))))
          }} />
          <div className="tune-knobs">
            <Knob label="Retune" hint="How fast the note snaps." value={values.retune ?? 0.95} min={0.02} max={1} text={String(Math.round((values.retune ?? 0.95) * 100))} color="#73c48f" onChange={(value) => set('retune', value)} />
            <Knob label="Humanize" hint="Leave some of the original pitch." value={values.humanize ?? 0.05} min={0} max={1} text={pct(values.humanize ?? 0.05)} color="#e0b15a" onChange={(value) => set('humanize', value)} />
            <Knob label="Mix" hint="How much correction you hear." value={values.amount ?? 0.85} min={0} max={1} text={pct(values.amount ?? 0.85)} color="#8fd0c4" onChange={(value) => set('amount', value)} />
            <Knob label="Flex" hint="Ignore small pitch errors." value={values.flex ?? 0} min={0} max={1} text={pct(values.flex ?? 0)} color="#d7a0c8" side onChange={(value) => set('flex', value)} />
            <Knob label="Vibrato" hint="Keep the fast pitch movement." value={values.vibrato ?? 0} min={0} max={1} text={pct(values.vibrato ?? 0)} color="#9eb6e0" side onChange={(value) => set('vibrato', value)} />
            <Knob label="Formant" hint="Let the tone follow the new pitch." value={values.formant ?? 0} min={0} max={1} text={(values.formant ?? 0) < 0.08 ? 'Keep' : pct(values.formant ?? 0)} color="#c4b48a" side onChange={(value) => set('formant', value)} />
          </div>
        </div>
      ) : (
        <div className="tune-graph" onPointerDown={(event) => beginDrag(event, canvas.current, notes.current, values, a4, drag)} onPointerMove={(event) => moveDrag(event, canvas.current, drag, set)} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
          <canvas ref={canvas} width={960} height={320} aria-label="Pitch notes. Drag a blob up or down to retune it." />
          <p>{blobs.length ? 'Drag a note up or down. That pitch class follows.' : 'Sing or play to see the pitch'}</p>
        </div>
      )}

      <div className="tune-row">
        <Stepper label="Range" hint="Detector range." value={TUNE_RANGES[rangeAt].name} onPrev={() => applyRange((rangeAt + TUNE_RANGES.length - 1) % TUNE_RANGES.length, patch)} onNext={() => applyRange((rangeAt + 1) % TUNE_RANGES.length, patch)} />
        <Stepper label="Key" hint="Song key, or a key for this track." value={keyLabel} onPrev={() => stepKey(values.root ?? -1, -1, set)} onNext={() => stepKey(values.root ?? -1, 1, set)} />
        <Stepper label="Scale" hint="Song scale, or chromatic." value={scaleLabel} onPrev={() => stepScale(values, -1, patch)} onNext={() => stepScale(values, 1, patch)} />
        <div className="tune-ref side">
          <span>Reference</span>
          <small>Concert A, in Hz.</small>
          <div>
            <button type="button" aria-label="Lower the reference pitch." title="Lower the reference pitch by 1 Hz." onClick={() => set('a4', Math.max(430, Math.round(values.a4 ?? 440) - 1))}>−</button>
            <strong>{Math.round(values.a4 ?? 440)} Hz</strong>
            <button type="button" aria-label="Raise the reference pitch." title="Raise the reference pitch by 1 Hz." onClick={() => set('a4', Math.min(450, Math.round(values.a4 ?? 440) + 1))}>+</button>
          </div>
        </div>
      </div>

      <div className="tune-tools" role="group" aria-label="Note edit tool">
        <button type="button" className={tool === 'remove' ? 'on' : ''} aria-pressed={tool === 'remove'} title="Drop a scale note. Sung pitches move to a neighbor." aria-label="Remove. Drop a scale note." onClick={() => setTool('remove')}>Remove</button>
        <button type="button" className={tool === 'bypass' ? 'on' : ''} aria-pressed={tool === 'bypass'} title="Let that note through without correction." aria-label="Bypass note. Let that note through." onClick={() => setTool('bypass')}>Bypass</button>
        <button type="button" className={latch ? 'on' : ''} aria-pressed={latch} title="A tap sticks until you tap again." aria-label="Latch. A tap sticks." onClick={() => setLatch(true)}>Latch</button>
        <button type="button" className={latch ? '' : 'on'} aria-pressed={!latch} title="The edit lasts while your finger is down." aria-label="Momentary. The edit lasts while held." onClick={() => setLatch(false)}>Moment</button>
        <button type="button" className="side" title="Set the key from the note you are singing." aria-label="Listen. Set the key from the sung note." onClick={() => {
          const pc = heardPitchClass(shownTrace, a4)
          if (pc != null) set('root', pc)
        }}>Listen</button>
        <button type="button" className={`side ${(values.hq ?? 0) >= 0.5 ? 'on' : ''}`} aria-pressed={(values.hq ?? 0) >= 0.5} title={(values.hq ?? 0) >= 0.5 ? 'HQ correction, with more delay.' : 'Low latency while you play.'} aria-label={(values.hq ?? 0) >= 0.5 ? 'HQ. Cleaner correction, more delay.' : 'Low latency. Short delay while you play.'} onClick={() => set('hq', (values.hq ?? 0) >= 0.5 ? 0 : 1)}>{(values.hq ?? 0) >= 0.5 ? 'HQ' : 'Low latency'}</button>
        <button type="button" className={`side ${(values.color ?? 0) >= 0.5 ? 'on' : ''}`} aria-pressed={(values.color ?? 0) >= 0.5} title={(values.color ?? 0) >= 0.5 ? 'Classic is a harder snap.' : 'Modern keeps the flex window.'} aria-label={(values.color ?? 0) >= 0.5 ? 'Classic. Harder snap.' : 'Modern. Softer snap.'} onClick={() => set('color', (values.color ?? 0) >= 0.5 ? 0 : 1)}>{(values.color ?? 0) >= 0.5 ? 'Classic' : 'Modern'}</button>
      </div>

      <div className="tune-notes" role="group" aria-label="Scale notes">
        {NOTE_NAMES.map((name, pc) => {
          const on = bitOn(mask, pc)
          const pass = bitOn(Math.round(values.bypassMask || 0), pc)
          return (
            <button
              key={name}
              type="button"
              data-note={name}
              className={`${on ? 'on' : 'off'} ${pass ? 'pass' : ''} ${isBlackKey(pc) ? 'sharp' : ''}`}
              aria-pressed={on && !pass}
              title={`${name}. ${toolHint}`}
              aria-label={`${name}. ${on ? 'In the scale.' : 'Out of the scale.'} ${pass ? 'Bypassed.' : ''}`}
              onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); editNote(pc, true) }}
              onPointerUp={() => { if (!latch) editNote(pc, false) }}
              onPointerCancel={() => { if (!latch) editNote(pc, false) }}
            >
              {name}
            </button>
          )
        })}
      </div>

      <div className="tune-piano" role="group" aria-label="Keyboard. Choose, remove, or bypass scale notes.">
        <div className="keybed">
          {whites().map((midi) => (
            <Key key={midi} midi={midi} mask={mask} passMask={Math.round(values.bypassMask || 0)} white onDown={editNote} onUp={(pc) => { if (!latch) editNote(pc, false) }} />
          ))}
          {blacks().map((midi) => (
            <Key key={midi} midi={midi} mask={mask} passMask={Math.round(values.bypassMask || 0)} onDown={editNote} onUp={(pc) => { if (!latch) editNote(pc, false) }} />
          ))}
        </div>
      </div>
    </section>
  )
}

function PitchMeter({ meter, held, onHold }: { meter: ReturnType<typeof readMeter>; held: boolean; onHold: () => void }) {
  const cents = meter?.cents ?? 0
  const angle = -120 + ((cents + 100) / 200) * 240
  return (
    <div className="tune-meter" data-live={meter ? 'on' : 'off'}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <path d={arcPath(100, 108, 78, -120, 120)} className="track" />
        <path d={arcPath(100, 108, 78, -120, Math.max(-119.5, angle))} className="value" />
        <line x1={polar(100, 108, 52, angle)[0]} y1={polar(100, 108, 52, angle)[1]} x2={polar(100, 108, 74, angle)[0]} y2={polar(100, 108, 74, angle)[1]} className="needle" />
      </svg>
      <div className="readout">
        <strong>{meter?.name ?? '–'}</strong>
        <em>{meter ? `${cents > 0 ? '+' : ''}${cents} ct` : 'Waiting for a note'}</em>
        <button type="button" className={held ? 'on' : ''} aria-pressed={held} title={held ? 'Release the held note.' : 'Hold the note you are singing.'} aria-label={held ? 'Hold on. Release the note.' : 'Hold. Stay on the sung note.'} onClick={onHold}>{held ? 'Holding' : 'Hold'}</button>
      </div>
    </div>
  )
}

function Knob({
  label, hint, value, min, max, text, color, side, onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  text: string
  color: string
  side?: boolean
  onChange: (value: number) => void
}) {
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min || 1)))
  const drag = useRef<{ y: number; value: number } | null>(null)
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return
    const span = max - min
    const next = drag.current.value + ((drag.current.y - event.clientY) / 140) * span
    onChange(Math.min(max, Math.max(min, next)))
  }
  return (
    <button
      type="button"
      className={`tune-knob ${side ? 'side' : ''}`}
      style={{ ['--p' as string]: String(ratio), ['--arc' as string]: color }}
      aria-label={`${label}. ${hint} ${text}.`}
      title={hint}
      onPointerDown={(event) => {
        drag.current = { y: event.clientY, value }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={move}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onKeyDown={(event) => {
        const step = (max - min) / 20
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(Math.min(max, value + step))
        if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(Math.max(min, value - step))
      }}
    >
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <path d={arcPath(40, 40, 28, -140, 140)} className="track" />
        <path d={arcPath(40, 40, 28, -140, -140 + Math.max(0.5, ratio * 280))} className="value" />
      </svg>
      <span className="cap"><i /></span>
      <b>{label}</b>
      <em>{text}</em>
    </button>
  )
}

function Stepper({ label, hint, value, preset, onPrev, onNext }: { label: string; hint: string; value: string; preset?: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="tune-step">
      <span>{label}</span>
      <small>{hint}</small>
      <div>
        <button type="button" aria-label={`Previous ${label}.`} title={`Previous ${label.toLowerCase()}.`} onClick={onPrev}>‹</button>
        <strong data-preset={preset}>{value}</strong>
        <button type="button" aria-label={`Next ${label}.`} title={`Next ${label.toLowerCase()}.`} onClick={onNext}>›</button>
      </div>
    </div>
  )
}

function Key({ midi, mask, passMask, white, onDown, onUp }: { midi: number; mask: number; passMask: number; white?: boolean; onDown: (pc: number, down: boolean) => void; onUp: (pc: number) => void }) {
  const pc = ((midi % 12) + 12) % 12
  const name = NOTE_NAMES[pc]
  const on = bitOn(mask, pc)
  const pass = bitOn(passMask, pc)
  const whitesBefore = countWhites(midi)
  return (
    <button
      type="button"
      className={`${white ? 'white' : 'black'} ${on ? 'on' : 'off'} ${pass ? 'pass' : ''}`}
      data-key={midi}
      aria-pressed={on && !pass}
      title={`${name}${octaveOf(midi)}. ${on ? 'In the scale.' : 'Removed.'}`}
      aria-label={`${name}${octaveOf(midi)}. ${on ? 'In the scale.' : 'Removed from the scale.'}`}
      style={white ? undefined : { left: `calc(${whitesBefore} * var(--white) - var(--black) / 2)` }}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); onDown(pc, true) }}
      onPointerUp={() => onUp(pc)}
      onPointerCancel={() => onUp(pc)}
    >
      {white && pc === 0 ? <em>C{octaveOf(midi)}</em> : null}
    </button>
  )
}

function whites() {
  const keys: number[] = []
  for (let midi = KEYBOARD_START; midi <= KEYBOARD_END; midi++) if (!isBlackKey(midi)) keys.push(midi)
  return keys
}

function blacks() {
  const keys: number[] = []
  for (let midi = KEYBOARD_START; midi <= KEYBOARD_END; midi++) if (isBlackKey(midi)) keys.push(midi)
  return keys
}

function countWhites(midi: number) {
  let count = 0
  for (let note = KEYBOARD_START; note < midi; note++) if (!isBlackKey(note)) count += 1
  return count
}

function octaveOf(midi: number) {
  return Math.floor(midi / 12) - 1
}

function toggleBitLocal(mask: number, pc: number) {
  return (mask ^ (1 << pc)) & 4095
}

function applyRange(index: number, patch: (next: Record<string, number>) => void) {
  const range = TUNE_RANGES[index]
  patch({ minHz: range.minHz, maxHz: range.maxHz })
}

function stepKey(root: number, dir: number, set: (id: string, value: number) => void) {
  const current = Math.round(root)
  const order = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const at = Math.max(0, order.indexOf(current < 0 ? -1 : ((current % 12) + 12) % 12))
  set('root', order[(at + dir + order.length) % order.length])
}

function stepScale(values: Record<string, number>, dir: number, patch: (next: Record<string, number>) => void) {
  const chromatic = (values.mode ?? 1) < 0.5
  const index = Math.round(values.scaleIndex ?? -1)
  const order: { mode: number; scaleIndex: number }[] = [
    { mode: 1, scaleIndex: -1 },
    { mode: 0, scaleIndex: -1 },
    ...SCALES.map((_, scaleIndex) => ({ mode: 1, scaleIndex })),
  ]
  const at = chromatic ? 1 : index < 0 ? 0 : index + 2
  const next = order[(at + dir + order.length) % order.length]
  patch({ ...next, custom: 0, mask: 0 })
}

function scaleText(values: Record<string, number>, projectScale: string) {
  if ((values.mode ?? 1) < 0.5) return 'Chromatic'
  const index = Math.round(values.scaleIndex ?? -1)
  if (index < 0) return `Project · ${projectScale}`
  return SCALES[index]?.name ?? projectScale
}

function nearestRange(minHz: number, maxHz: number) {
  let best = 0
  let dist = Infinity
  TUNE_RANGES.forEach((range, index) => {
    const next = Math.abs(range.minHz - minHz) + Math.abs(range.maxHz - maxHz)
    if (next < dist) {
      dist = next
      best = index
    }
  })
  return best
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

function polar(cx: number, cy: number, radius: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return [cx + radius * Math.sin(rad), cy - radius * Math.cos(rad)]
}

function arcPath(cx: number, cy: number, radius: number, start: number, end: number) {
  const [x0, y0] = polar(cx, cy, radius, start)
  const [x1, y1] = polar(cx, cy, radius, end)
  const large = end - start > 180 ? 1 : 0
  return `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1}`
}

const GRAPH_LOW = 48
const GRAPH_HIGH = 84

function drawGraph(view: HTMLCanvasElement | null, trace: Float32Array | null, values: Record<string, number>) {
  const ctx = view?.getContext('2d')
  if (!view || !ctx) return
  const width = view.width
  const height = view.height
  ctx.clearRect(0, 0, width, height)
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, '#1a2420')
  gradient.addColorStop(1, '#0d1210')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.font = '12px sans-serif'
  for (let midi = GRAPH_LOW; midi <= GRAPH_HIGH; midi++) {
    const y = midiY(midi, height)
    const black = isBlackKey(midi)
    ctx.fillStyle = black ? 'rgba(255,255,255,0.03)' : 'rgba(115,196,143,0.05)'
    ctx.fillRect(0, y - (height / (GRAPH_HIGH - GRAPH_LOW)) / 2, width, height / (GRAPH_HIGH - GRAPH_LOW))
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.moveTo(28, y)
    ctx.lineTo(width, y)
    ctx.stroke()
    if (midi % 12 === 0) {
      ctx.fillStyle = '#93a399'
      ctx.fillText(`C${Math.floor(midi / 12) - 1}`, 4, y + 4)
    }
  }
  const blobs = graphNotes(trace, values.a4 || 440)
  if (trace) {
    ctx.strokeStyle = '#e0b15a'
    ctx.lineWidth = 2
    ctx.beginPath()
    let drawing = false
    const frames = Math.floor(trace.length / 2)
    for (let i = 0; i < frames; i++) {
      const hz = trace[i * 2] || 0
      if (hz <= 0) {
        drawing = false
        continue
      }
      const midi = 69 + 12 * Math.log2(hz / (values.a4 || 440))
      const x = (i / Math.max(1, frames - 1)) * width
      const y = midiY(midi, height)
      if (!drawing) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      drawing = true
    }
    ctx.stroke()
  }
  if (!blobs.length) return
  const frames = 64
  blobs.forEach((note) => {
    const x = (note.start / frames) * width
    const w = Math.max(10, ((note.end - note.start) / frames) * width)
    const y = midiY(blobMidi(note, values.a4 || 440), height)
    ctx.fillStyle = 'rgba(115, 196, 143, 0.85)'
    roundRect(ctx, x, y - 8, w, 16, 8)
    ctx.fill()
  })
}

function midiY(midi: number, height: number) {
  const t = (midi - GRAPH_LOW) / (GRAPH_HIGH - GRAPH_LOW)
  return height - t * (height - 16) - 8
}

function yToMidi(y: number, height: number) {
  const t = 1 - (y - 8) / (height - 16)
  return GRAPH_LOW + t * (GRAPH_HIGH - GRAPH_LOW)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function beginDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  view: HTMLCanvasElement | null,
  blobs: ReturnType<typeof graphNotes>,
  values: Record<string, number>,
  a4: number,
  drag: { current: { startMidi: number; startCents: number; pc: number } | null },
) {
  if (!view) return
  const rect = view.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * view.width
  const y = ((event.clientY - rect.top) / rect.height) * view.height
  const hit = blobs.find((note) => {
    const left = (note.start / 64) * view.width
    const right = (note.end / 64) * view.width
    return x >= left && x <= right && Math.abs(y - midiY(blobMidi(note, a4), view.height)) < 18
  })
  if (!hit) return
  const visual = blobMidi(hit, a4)
  const id = nudgeKey(visual, values)
  drag.current = { startMidi: visual, startCents: values[id] ?? 0, pc: Number(id.slice(1)) }
  event.currentTarget.setPointerCapture(event.pointerId)
}

function moveDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  view: HTMLCanvasElement | null,
  drag: { current: { startMidi: number; startCents: number; pc: number } | null },
  set: (id: string, value: number) => void,
) {
  if (!view || !drag.current) return
  const rect = view.getBoundingClientRect()
  const y = ((event.clientY - rect.top) / rect.height) * view.height
  const next = dragNudge(drag.current.startMidi, yToMidi(y, view.height), drag.current.startCents, drag.current.pc)
  set(next.id, next.cents)
}
