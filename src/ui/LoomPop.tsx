import { useEffect, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import {
  activeInstrument,
  advanceNote,
  articulationForCC,
  voiceState,
  blendPatches,
  compileScript,
  memoryBudget,
  mutatePatch,
  planStream,
  type LayerKind,
  type LoomState,
  type Mic,
  type ModDest,
  type ModSource,
  type Patch,
} from '../model/loom'
import type { ProjectStore } from '../state/store'
import type { FormFactor } from './form'

const KINDS: LayerKind[] = ['sample', 'analog', 'wave', 'fm', 'grain', 'physical']
const SOURCES: ModSource[] = ['lfo', 'env', 'vel', 'cc1', 'note']
const DESTS: ModDest[] = ['cutoff', 'level', 'pan', 'pitch']
const MICS: Mic[] = ['close', 'room', 'far']
const KEYS = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]

export function LoomPop({
  store,
  engine,
  form,
  open,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  form: FormFactor
  open: boolean
  onClose: () => void
}) {
  const state = store.project.loom
  useEffect(() => {
    if (!open || !navigator.requestMIDIAccess) return
    let dead = false
    let access: MIDIAccess | null = null
    const bind = (midi: MIDIAccess) => {
      for (const input of midi.inputs.values()) {
        input.onmidimessage = (event) => {
          const data = event.data
          const current = store.project.loom
          if (!data || !current) return
          const status = data[0] & 0xf0
          const channel = (data[0] & 0x0f) + 1
          if (status === 0xb0 && data[1] === 1) {
            store.setLoom({ ...current, cc1: data[2] / 127 }, false)
            return
          }
          if (status === 0xb0 && data[1] === 32) {
            const instrument = activeInstrument(current)
            if (!instrument) return
            store.setLoom({ ...current, articulation: articulationForCC(instrument, data[2]) })
            return
          }
          if (status === 0x90 && data[2] > 0) play(data[1], data[2] / 127, channel)
        }
      }
    }
    void navigator.requestMIDIAccess().then((midi) => {
      if (dead) return
      access = midi
      bind(midi)
      midi.onstatechange = () => bind(midi)
    }).catch(() => {
      /* MIDI permission denied or unavailable. */
    })
    return () => {
      dead = true
      if (!access) return
      access.onstatechange = null
      for (const input of access.inputs.values()) input.onmidimessage = null
    }
  }, [open, store, engine])

  if (!open || !state) return null
  const instrument = activeInstrument(state)
  const patch = state.patches.find((item) => item.id === state.patchId) ?? state.patches[0]
  if (!instrument || !patch) return null
  const budgetForm = form === 'phone' ? 'phone' : form === 'fold' ? 'fold' : 'desk'
  const budget = memoryBudget(budgetForm)
  const plan = planStream(instrument.zones, state.articulation, state.lite, budget, () => 180_000)
  const script = compileScript(instrument.script)

  function edit(next: LoomState, record = true) {
    store.setLoom(next, record)
  }

  function editPatch(next: Patch, record = true) {
    const current = store.project.loom
    if (!current) return
    edit({ ...current, patches: current.patches.map((item) => (item.id === next.id ? next : item)) }, record)
  }

  function play(pitch: number, vel = 0.8, channel = 0) {
    const current = store.project.loom
    if (!current) return
    const step = advanceNote(voiceState(current, channel, pitch), pitch)
    if (!step.sound) {
      edit({ ...current, articulation: step.articulation })
      return
    }
    engine.unlock()
    engine.previewLoom(pitch, vel, channel)
    edit({ ...current, rr: step.rr }, false)
  }

  function setScript(name: string, value: number) {
    const current = store.project.loom
    const inst = current ? activeInstrument(current) : null
    if (!current || !inst) return
    const line = `${name}(${Math.round(value)})`
    const script = new RegExp(`${name}\\(`).test(inst.script) ? inst.script.replace(new RegExp(`${name}\\([^)]*\\)`), line) : `${inst.script}\n${line}`.trim()
    const compiled = compileScript(script)
    if (compiled.error) return
    edit({
      ...current,
      instruments: current.instruments.map((item) => (item.id === inst.id ? { ...item, script } : item)),
    })
  }

  return (
    <div className="loom-pop" role="dialog" aria-label="Loom" data-loom="open" data-deep={state.deep ? '1' : '0'} data-art={state.articulation} data-lite={state.lite ? '1' : '0'}>
      <header>
        <strong>{instrument.name}</strong>
        <span className="loom-mem">{mb(budget)} cap · {mb(plan.bytes)} preload{state.lite ? ' · Lite' : ''}</span>
        <button type="button" className={`text-btn deep-btn ${state.deep ? 'on' : ''}`} aria-pressed={state.deep} onClick={() => edit({ ...state, deep: !state.deep })}>Deep</button>
        <button type="button" className="text-btn" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="loom-body">
        <section className="loom-play">
          <div className="art-row">
            {instrument.articulations.map((art) => (
              <button key={art.id} type="button" className={state.articulation === art.id ? 'on' : ''} onClick={() => edit({ ...state, articulation: art.id })}>
                {art.name}
              </button>
            ))}
          </div>
          <div
            className="loom-orb"
            role="slider"
            aria-label="Orb"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.xy.x * 100)}
            style={{ ['--x' as string]: `${state.xy.x * 100}%`, ['--y' as string]: `${(1 - state.xy.y) * 100}%` }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              moveOrb(event)
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) moveOrb(event)
            }}
          />
          <label className="loom-field">
            Dynamics
            <input type="range" min={0} max={1} step={0.01} value={state.cc1} aria-label="Dynamics" onChange={(event) => edit({ ...state, cc1: Number(event.target.value) }, false)} />
          </label>
          <div className="mic-row">
            {MICS.map((mic) => (
              <label key={mic} className="loom-field">
                {mic}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  aria-label={mic}
                  value={state.mics[mic]}
                  disabled={state.lite && mic !== 'close'}
                  onChange={(event) => edit({ ...state, mics: { ...state.mics, [mic]: Number(event.target.value) } }, false)}
                />
              </label>
            ))}
          </div>
          <div className="loom-row">
            <label className="loom-field">
              Humanize
              <input type="range" min={0} max={24} step={1} aria-label="Humanize" value={amount(instrument.script, 'humanize')} onChange={(event) => setScript('humanize', Number(event.target.value))} />
            </label>
            <label className="loom-field">
              Strum
              <input type="range" min={0} max={40} step={1} aria-label="Strum" value={amount(instrument.script, 'strum')} onChange={(event) => setScript('strum', Number(event.target.value))} />
            </label>
          </div>
          <div className="loom-keys">
            {KEYS.map((pitch) => {
              const black = [1, 3, 6, 8, 10].includes(pitch % 12)
              return (
                <button key={pitch} type="button" className={black ? 'black' : ''} aria-label={`Play ${pitch}`} onClick={() => play(pitch)}>
                  {pitch % 12 === 0 ? 'C' : ''}
                </button>
              )
            })}
          </div>
          {script.error && <p className="loom-note">Script blocked</p>}
        </section>
        {state.deep && (
          <section className="loom-edit" aria-label="Deep edit">
            <div className="art-row">
              <button type="button" onClick={() => edit({ ...state, lite: !state.lite })}>{state.lite ? 'Lite on' : 'Lite'}</button>
              <button type="button" onClick={() => editPatch(kept(mutatePatch(patch, state.seed + 1), patch))}>Mutate</button>
              <button type="button" onClick={() => {
                const other = state.patches.find((item) => item.id !== patch.id) ?? mutatePatch(patch, state.seed + 3)
                editPatch(kept(blendPatches(patch, other, 0.5), patch))
              }}>Blend</button>
              <button type="button" onClick={() => playChord(play)}>Arp</button>
            </div>
            {patch.layers.map((layer, index) => (
              <div key={`${layer.kind}-${index}`} className="loom-line">
                <select
                  aria-label={`Layer ${index + 1}`}
                  value={layer.kind}
                  onChange={(event) => editPatch({ ...patch, layers: patch.layers.map((item, at) => (at === index ? { ...item, kind: event.target.value as LayerKind } : item)) })}
                >
                  {KINDS.map((kind) => <option key={kind} value={kind}>{label(kind)}</option>)}
                </select>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  aria-label={`Layer ${index + 1} level`}
                  value={layer.level}
                  onChange={(event) => editPatch({ ...patch, layers: patch.layers.map((item, at) => (at === index ? { ...item, level: Number(event.target.value) } : item)) }, false)}
                />
              </div>
            ))}
            {patch.layers.length < 4 && (
              <button type="button" className="text-btn" onClick={() => editPatch({ ...patch, layers: [...patch.layers, { ...patch.layers[0], kind: 'wave', level: 0.3 }] })}>Add layer</button>
            )}
            {patch.routes.map((route, index) => (
              <div key={`${route.source}-${route.dest}-${index}`} className="loom-line">
                <select aria-label={`Mod source ${index + 1}`} value={route.source} onChange={(event) => editPatch({ ...patch, routes: patch.routes.map((item, at) => (at === index ? { ...item, source: event.target.value as ModSource } : item)) })}>
                  {SOURCES.map((source) => <option key={source} value={source}>{label(source)}</option>)}
                </select>
                <select aria-label={`Mod dest ${index + 1}`} value={route.dest} onChange={(event) => editPatch({ ...patch, routes: patch.routes.map((item, at) => (at === index ? { ...item, dest: event.target.value as ModDest } : item)) })}>
                  {DESTS.map((dest) => <option key={dest} value={dest}>{label(dest)}</option>)}
                </select>
              </div>
            ))}
            <p className="loom-note">{instrument.zones.length} zones · release · legato · {state.slots.length} slots</p>
            {state.slots.map((slot, index) => (
              <div key={`${slot.instrumentId}-${index}`} className="loom-line">
                <span>{state.instruments.find((item) => item.id === slot.instrumentId)?.name ?? 'Instrument'}</span>
                <span>{slot.channel === 0 ? 'Omni' : `Ch ${slot.channel}`}</span>
                <span>{slot.low}–{slot.high}</span>
              </div>
            ))}
            {state.slots.length < 8 && (
              <button type="button" className="text-btn" onClick={() => edit({
                ...state,
                slots: [...state.slots, { instrumentId: instrument.id, patchId: patch.id, channel: state.slots.length + 1, low: 0, high: 127, output: state.slots.length }],
              })}>Add slot</button>
            )}
          </section>
        )}
      </div>
    </div>
  )

  function moveOrb(event: ReactPointerEvent<HTMLDivElement>) {
    const current = store.project.loom
    if (!current) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = clamp((event.clientX - box.left) / box.width)
    const y = clamp(1 - (event.clientY - box.top) / box.height)
    edit({ ...current, xy: { x, y } }, false)
  }
}

function playChord(play: (pitch: number, vel?: number) => void) {
  ;[60, 64, 67, 72].forEach((pitch, index) => {
    window.setTimeout(() => play(pitch, 0.75), index * 90)
  })
}

function kept(next: Patch, previous: Patch): Patch {
  return { ...next, id: previous.id, name: previous.name }
}

function amount(script: string, name: string) {
  const match = script.match(new RegExp(`${name}\\((-?\\d+(?:\\.\\d+)?)\\)`))
  return match ? Number(match[1]) : 0
}

function mb(bytes: number) {
  const value = bytes / (1024 * 1024)
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} MB`
}

function label(value: string) {
  const names: Record<string, string> = { cc1: 'Wheel', fm: 'FM', lfo: 'LFO' }
  return names[value] ?? value.charAt(0).toUpperCase() + value.slice(1)
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}
