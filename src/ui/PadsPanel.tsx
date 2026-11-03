import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { Performer, pointerVelocity, type PerformTarget } from '../audio/performer'
import { ensureDefaultKit } from '../instruments/pads/load'
import { clipBeat, padFaceName } from '../instruments/pads/record'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { countInBarsOf, countInCaption } from '../model/time'
import { projectSampleBeat } from '../model/tempoMap'
import { BANKS, sixteenLevels, type LevelSpread } from '../model/padMachine'
import { REPEAT_CHOICES, VELOCITY_CURVES, repeatSetting, stepOn, stepVelocity } from '../instruments/mpc/model'
import { emptyTap, pushTap } from '../model/tap'
import type { ProjectStore } from '../state/store'
import { SOUND_MIME } from '../audio/sample/slot'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { loadSoundCatalog } from '../sounds/catalog'
import { decodeSoundBytes } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import { onMidiMessage } from '../midi/access'
import { setPerformanceOwnsMidi } from '../midi/remember'
import { useFormFactor } from './form'
import './pads.css'

const PAD_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV']
const VISIBLE_BANKS = BANKS.slice(0, 4)

export function PadsPanel({
  store,
  engine,
  trackId,
  onRecord,
  onEdit,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  onRecord: () => void
  onEdit: (clipId: string) => void
}) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const phone = useFormFactor() === 'phone'
  const kit = store.trackKit(trackId)
  const bank = Math.min(3, kit.activeBank || 0)
  const pads = kit.banks[bank] ?? []
  const board = useRef<HTMLDivElement>(null)
  const performer = useRef<Performer | null>(null)
  const target = useRef<PerformTarget | null>(null)
  const [selected, setSelected] = useState(0)
  const [levels, setLevels] = useState<LevelSpread | ''>('')
  const [repeatOn, setRepeatOn] = useState(false)
  const [eraseOn, setEraseOn] = useState(false)
  const [recordMode, setRecordMode] = useState<'overdub' | 'replace'>('overdub')
  const [stepPick, setStepPick] = useState(0)
  const taps = useRef(emptyTap())
  const [litPads, setLitPads] = useState<number[]>([])
  const [litNotes, setLitNotes] = useState<number[]>([])
  const [meters, setMeters] = useState<number[]>(() => Array(16).fill(0))
  const [status, setStatus] = useState(engine.status)
  const sounds = useRef<SoundEntry[]>([])
  const selectedPad = pads[selected] ?? pads[0]
  const recording = status === 'recording' || status === 'counting-in'
  const tool = recording ? 'Record' : eraseOn ? 'Erase' : repeatOn ? 'Repeat' : levels ? '16 Levels' : 'Play'

  if (!performer.current) {
    performer.current = new Performer(
      engine,
      () => target.current,
      (aimed, notes, mode) => store.commitPadHits(aimed.trackId, notes, mode),
      () => engine.status === 'recording',
      (aimed, pitch, from, to) => {
        const window = store.padRecord
        const clip = store.track(aimed.trackId)?.midiClips.find((item) => item.id === aimed.clipId)
        const clipStart = window?.clipStart ?? clip?.startBeat ?? 0
        const loopStart = window?.loopStart ?? clipStart
        const loopEnd = window?.loopEnd ?? clipStart + (clip?.durationBeats ?? 4)
        const start = clipBeat(from, clipStart, loopStart, loopEnd)
        const end = clipBeat(to, clipStart, loopStart, loopEnd)
        store.erasePadNotes(aimed.trackId, aimed.clipId, pitch, Math.min(start, end), Math.max(start, end) + 0.05)
      },
      () => store.endDraft(),
    )
  }
  const play = performer.current
  const repeat = repeatSetting(kit.repeatRate || '1/16')
  play.setGrid(repeatOn ? repeat.rate : null, repeat.triplet)
  play.setEngaged(repeatOn)
  play.setQuantize(0)
  play.setTempo(kit.syncTempo === false && kit.localBpm > 0 ? kit.localBpm : null)
  play.setDeck({
    kit,
    swing: kit.trackSwing,
    fullLevel: kit.fullLevel,
    accent: false,
    erase: eraseOn,
    latch: kit.repeatLatch,
    levels: levels || null,
    fixedBeats: 0,
    recordMode,
    sampleOf: (id) => store.buffers.get(id)?.channels[0] ?? null,
  })

  useEffect(() => {
    const clipId = store.padRecord?.trackId === trackId
      ? store.padRecord.clipId
      : store.track(trackId)?.midiClips.find((clip) => clip.id === store.selectedMidiClipId)?.id
        ?? store.track(trackId)?.midiClips[0]?.id
    target.current = clipId ? { trackId, clipId, drums: true } : null
  })

  useEffect(() => {
    engine.setPadRoute(trackId)
    engine.setBeatPump((now, horizon) => play.pumpRepeats(now, horizon))
    setPerformanceOwnsMidi(true)
    return () => {
      play.setEngaged(false)
      engine.setBeatPump(null)
      engine.setPadRoute(null)
      setPerformanceOwnsMidi(false)
    }
  }, [engine, play, trackId])

  useEffect(() => {
    void ensureDefaultKit(store, trackId)
    void loadSoundCatalog(fetch, soundCache()).then((result) => { sounds.current = result.entries })
  }, [store, trackId])

  useEffect(() => engine.subscribe(() => setStatus(engine.status)), [engine])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMeters((list) => {
        if (list.every((value) => value === 0)) return list
        return list.map((value) => (value < 0.04 ? 0 : value * 0.88))
      })
    }, 48)
    return () => window.clearInterval(timer)
  }, [])

  const bumpMeter = (index: number, velocity: number) => {
    if (!Number.isFinite(index) || index < 0) return
    setMeters((list) => {
      const next = list.slice()
      next[index] = Math.max(0.15, Math.min(1, velocity))
      return next
    })
  }

  useEffect(() => {
    let last = -1
    const timer = window.setInterval(() => {
      if (engine.status !== 'recording') {
        last = -1
        return
      }
      const beat = projectSampleBeat(store.project, engine.positionSamples)
      if (last >= 0 && beat + 0.25 < last) {
        const rec = store.padRecord
        if (rec?.trackId === trackId) store.armTakeUndo(rec.trackId, rec.clipId)
      }
      last = beat
    }, 40)
    return () => window.clearInterval(timer)
  }, [engine, store, trackId])

  useEffect(() => {
    const root = board.current
    if (!root) return
    const pointers = new Map<number, number>()
    const down = (event: PointerEvent) => {
      const key = (event.target as HTMLElement).closest?.('[data-pad]') as HTMLElement | null
      if (!key || !root.contains(key)) return
      event.preventDefault()
      const index = Number(key.dataset.pad)
      const pitch = Number(key.dataset.pitch)
      const velocity = pointerVelocity(event, key.getBoundingClientRect())
      play.down(pitch, velocity, event.timeStamp, event.pointerId, levels ? index : undefined)
      setSelected(index)
      bumpMeter(index, velocity)
      pointers.set(event.pointerId, index)
      setLitPads([...pointers.values()])
      try { key.setPointerCapture(event.pointerId) } catch { /* the pointer already ended */ }
    }
    const up = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      play.up(event.pointerId, event.timeStamp)
      pointers.delete(event.pointerId)
      setLitPads([...pointers.values()])
    }
    const move = (event: PointerEvent) => {
      if (!kit.repeatPressure || !pointers.has(event.pointerId)) return
      const key = (event.target as HTMLElement).closest?.('[data-pad]') as HTMLElement | null
      if (!key) return
      play.pressure(event.pointerId, pointerVelocity(event, key.getBoundingClientRect()), event.timeStamp)
    }
    root.addEventListener('pointerdown', down)
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerup', up)
    root.addEventListener('pointercancel', up)
    return () => {
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerup', up)
      root.removeEventListener('pointercancel', up)
    }
  }, [kit.repeatPressure, levels, play])

  useEffect(() => {
    const held = new Map<string, number>()
    const down = (event: KeyboardEvent) => {
      if (event.repeat) return
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const index = PAD_KEYS.indexOf(event.code)
      if (index < 0) return
      const pad = pads[index]
      if (!pad) return
      event.preventDefault()
      const pitch = levels && selectedPad ? selectedPad.pitch : pad.pitch
      held.set(event.code, index + 1)
      play.down(pitch, 0.9, event.timeStamp, index + 1, levels ? index : undefined)
      setSelected(index)
      bumpMeter(index, 0.9)
      setLitPads((list) => list.includes(index) ? list : [...list, index])
    }
    const up = (event: KeyboardEvent) => {
      const pointer = held.get(event.code)
      if (pointer == null) return
      held.delete(event.code)
      const index = pointer - 1
      play.up(pointer, event.timeStamp)
      setLitPads((list) => list.filter((item) => item !== index))
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [levels, pads, play, selectedPad])

  useEffect(() => {
    if (!hardwareMidiAllowed(navigator.userAgent)) return
    return onMidiMessage((_input, data, timeStamp) => {
      play.midi(data, timeStamp, performance.now())
      if (data.length < 3) return
      const on = (data[0] & 0xf0) === 0x90 && data[2] > 0
      const pitch = data[1]
      setLitNotes((list) => on ? (list.includes(pitch) ? list : [...list, pitch]) : list.filter((item) => item !== pitch))
    })
  }, [play])

  async function dropSound(index: number, event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer.getData(SOUND_MIME) || event.dataTransfer.getData('text/plain')
    const entry = sounds.current.find((item) => item.id === id)
    if (!entry) return
    try {
      const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
      const decoded = await decodeSoundBytes(bytes)
      const samples = decoded.channels[0]
      if (!samples?.length) return
      store.assignTrackPad(trackId, bank, index, { name: entry.name, samples, sampleRate: decoded.sampleRate })
      setSelected(index)
    } catch {
      store.toast('That sound could not be loaded onto the pad.', 'warn')
    }
  }

  function record() {
    if (engine.status === 'recording' || engine.status === 'counting-in') {
      onRecord()
      return
    }
    const track = store.project.tracks.find((item) => item.id === trackId)
    if (!track?.armed) {
      store.toast('Arm this track to record.', 'info')
      return
    }
    const beat = projectSampleBeat(store.project, engine.positionSamples)
    store.armPadRecord(trackId, beat)
    onRecord()
  }

  function edit() {
    const beat = projectSampleBeat(store.project, engine.positionSamples)
    const clipId = store.ensurePadClip(trackId, beat)
    if (clipId) onEdit(clipId)
  }

  const source = levels && selectedPad ? selectedPad : selectedPad

  return (
    <div className={`mpc ch-sheet ${phone ? 'phone' : ''}`} data-pads="plugin" aria-label="Pads">
      <div className="mpc-top">
        <strong>Sampler</strong>
        <span className="mpc-kind">Drums</span>
        {VISIBLE_BANKS.map((name, index) => (
          <button
            key={name}
            type="button"
            className={`ch-tab${bank === index ? ' on' : ''}`}
            aria-pressed={bank === index}
            title={`Bank ${name}. Sixteen pads.`}
            onClick={() => store.patchTrackKit(trackId, { activeBank: index })}
          >{name}</button>
        ))}
        <button type="button" className={`ch-tab${recording ? ' on' : ''}`} aria-pressed={recording} title="Record pad hits into a clip on this track, with the count-in and the loop." onClick={record}>Record</button>
        <button type="button" className={`ch-tab${kit.timing ? ' on' : ''}`} aria-pressed={kit.timing} title="Snap hits to the grid with MPC swing." onClick={() => store.patchTrackKit(trackId, { timing: !kit.timing, timingGrid: 0.25, timingStrength: 1 })}>Quantize</button>
        <button
          type="button"
          className={`ch-tab${repeatOn ? ' on' : ''}`}
          aria-pressed={repeatOn}
          title="Note repeat. The pad retriggers at the chosen rate."
          onClick={() => setRepeatOn((value) => !value)}
        >Note repeat</button>
        <button
          type="button"
          className={`ch-tab${eraseOn ? ' on' : ''}`}
          aria-pressed={eraseOn}
          title="Hold Erase and a pad to clear that sound while the loop plays."
          onPointerDown={(event) => { event.preventDefault(); setEraseOn(true) }}
          onPointerUp={() => setEraseOn(false)}
          onPointerCancel={() => setEraseOn(false)}
          onPointerLeave={() => setEraseOn(false)}
        >Erase</button>
        <button type="button" className="ch-tab" title="Undo" disabled={!store.canUndo} onClick={() => store.undo()}>Undo</button>
        <button type="button" className={`ch-tab${store.project.countIn ? ' on' : ''}`} aria-pressed={store.project.countIn} title={`Count-in is ${countInCaption(countInBarsOf(store.project))}. Tap for off, one bar, or two bars.`} onClick={() => store.cycleCountIn()}>Count</button>
        <button type="button" className={`ch-tab${store.project.metronomeEnabled ? ' on' : ''}`} aria-pressed={store.project.metronomeEnabled} title="Metronome while the pads record." onClick={() => store.toggle('metronomeEnabled')}>Click</button>
        <select aria-label="16 Levels" title="One pad spread across 16 velocities, tunes, or decays." value={levels} onChange={(event) => setLevels(event.target.value as LevelSpread | '')}>
          <option value="">16 Levels</option>
          <option value="velocity">Velocity</option>
          <option value="tune">Tune</option>
          <option value="filter">Filter</option>
          <option value="decay">Decay</option>
          <option value="attack">Attack</option>
        </select>
        <button type="button" className="ch-tab" title="Open this clip in the piano roll." onClick={edit}>Roll</button>
        <button type="button" className="ch-tab mpc-close" title="Close Pads. The track keeps the instrument." aria-label="Close Pads. The track keeps the instrument." onClick={() => store.closePads()}>Close</button>
      </div>
      <p className="mpc-tool ch-recessed" data-tool={tool}>Tool: <b>{tool}</b></p>
      <div className="mpc-tools">
        <select aria-label="Output" title="MIDI out records clips and can drive another instrument. Audio out renders the pads. Both does both." value={kit.output} onChange={(event) => store.patchTrackKit(trackId, { output: event.target.value as 'midi' | 'audio' | 'both' })}>
          <option value="midi">MIDI out</option>
          <option value="audio">Audio out</option>
          <option value="both">Both</option>
        </select>
        <button type="button" className={`ch-tab${kit.multiOut ? ' on' : ''}`} aria-pressed={kit.multiOut} title="Send each pad to its own bus." onClick={() => store.patchTrackKit(trackId, { multiOut: !kit.multiOut })}>Multi out</button>
        <select aria-label="Note repeat rate" title="Straight notes and triplets, from a quarter to a thirty-second." value={kit.repeatRate} onChange={(event) => store.patchTrackKit(trackId, { repeatRate: event.target.value })}>
          {REPEAT_CHOICES.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
        <button type="button" className={`ch-tab${kit.repeatLatch ? ' on' : ''}`} aria-pressed={kit.repeatLatch} title="Latch keeps note repeat playing after the pad is released." onClick={() => store.patchTrackKit(trackId, { repeatLatch: !kit.repeatLatch })}>Latch</button>
        <button type="button" className={`ch-tab${recordMode === 'overdub' ? ' on' : ''}`} aria-pressed={recordMode === 'overdub'} title="Overdub keeps the notes already in the loop." onClick={() => setRecordMode('overdub')}>Overdub</button>
        <button type="button" className={`ch-tab${recordMode === 'replace' ? ' on' : ''}`} aria-pressed={recordMode === 'replace'} title="Replace clears the loop while you record." onClick={() => setRecordMode('replace')}>Replace</button>
        <button type="button" className={`ch-tab${kit.syncTempo ? ' on' : ''}`} aria-pressed={kit.syncTempo} title="Sync note repeat to the project tempo." onClick={() => store.patchTrackKit(trackId, { syncTempo: !kit.syncTempo })}>Sync</button>
        <button type="button" className="ch-tab" title="Tap tempo. With sync on, this sets the project tempo." onClick={() => {
          const result = pushTap(taps.current, performance.now(), 'pointer')
          taps.current = result.memory
          if (result.bpm == null) return
          if (kit.syncTempo) store.setTempo(result.bpm)
          else store.patchTrackKit(trackId, { localBpm: result.bpm, syncTempo: false })
        }}>Tap tempo</button>
        <button type="button" className="ch-tab" title="Chop the selected pad on transients and spread the slices across this bank." onClick={() => store.chopTrackPad(trackId, bank, selected, 'transient')}>Transient</button>
        <button type="button" className="ch-tab" title="Chop the selected pad on a grid and spread the slices across this bank." onClick={() => store.chopTrackPad(trackId, bank, selected, 'grid')}>Grid</button>
        <button type="button" className="ch-tab" title="Chop the selected pad at its start and end and spread the slices across this bank." onClick={() => store.chopTrackPad(trackId, bank, selected, 'manual')}>Manual</button>
        <button type="button" className="ch-tab" title="Place the song chain on the arrangement." onClick={() => store.placeMpcSong(trackId)}>Place song</button>
        <button type="button" className="ch-tab" title="Render the pattern to an audio clip." onClick={() => store.printMpcAudio(trackId)}>Print audio</button>
        <label>Timing
          <input aria-label="Humanize timing" title="How far live hits and the Humanize edit may move, in beats." type="range" min={0} max={0.25} step={0.005} value={kit.humanizeTime} onChange={(event) => store.patchTrackKit(trackId, { humanizeTime: Number(event.target.value) })} />
        </label>
        <label>Velocity
          <input aria-label="Humanize velocity" title="How far live hits and the Humanize edit may change velocity." type="range" min={0} max={1} step={0.01} value={kit.humanizeVelocity} onChange={(event) => store.patchTrackKit(trackId, { humanizeVelocity: Number(event.target.value) })} />
        </label>
        <button type="button" className="ch-tab" title="Rewrite the pattern and the recorded clip with this timing and velocity scatter." onClick={() => store.humanizePadTake(trackId)}>Humanize</button>
        <select aria-label="Velocity curve" title="Linear, soft, hard, or a fixed velocity." value={kit.velocityCurve} onChange={(event) => store.patchTrackKit(trackId, { velocityCurve: Number(event.target.value) })}>
          {VELOCITY_CURVES.map((curve) => <option key={curve.id} value={curve.id}>{curve.label}</option>)}
        </select>
        <label>Scale
          <input aria-label="Velocity scale" title="How strongly the curve replaces the played velocity." type="range" min={0} max={1} step={0.01} value={kit.velocityAmount} onChange={(event) => store.patchTrackKit(trackId, { velocityAmount: Number(event.target.value) })} />
        </label>
        <label>Minimum
          <input aria-label="Velocity minimum" title="Softest velocity the curve may produce." type="range" min={0} max={1} step={0.01} value={kit.velocityMin} onChange={(event) => store.patchTrackKit(trackId, { velocityMin: Number(event.target.value) })} />
        </label>
        <label>Maximum
          <input aria-label="Velocity maximum" title="Loudest velocity the curve may produce." type="range" min={0} max={1} step={0.01} value={kit.velocityMax} onChange={(event) => store.patchTrackKit(trackId, { velocityMax: Number(event.target.value) })} />
        </label>
        <label>Fixed
          <input aria-label="Fixed velocity" title="Velocity used by Fixed curve and by pads with no sensitivity." type="range" min={0.01} max={1} step={0.01} value={kit.velocityFixed} onChange={(event) => store.patchTrackKit(trackId, { velocityFixed: Number(event.target.value) })} />
        </label>
      </div>
      <div className="mpc-steps" aria-label="Steps">
        {Array.from({ length: 16 }, (_, step) => {
          const sequence = kit.sequences[0]
          const stepBeats = (sequence?.lengthBeats || 4) / 16
          const on = sequence ? stepOn(sequence.notes, pads[selected]?.pitch ?? 0, step, stepBeats) : false
          const level = sequence ? stepVelocity(sequence.notes, pads[selected]?.pitch ?? 0, step, stepBeats) : null
          return (
            <button key={step} type="button" className={`ch-tab${on ? ' on' : ''}${stepPick === step ? ' sel' : ''}`} aria-pressed={on} aria-label={`Step ${step + 1}`} title={level == null ? `Step ${step + 1}` : `Step ${step + 1}. Velocity ${Math.round(level * 127)}.`} onClick={() => { setStepPick(step); store.toggleMpcStep(trackId, bank, selected, step, kit.velocityFixed) }}>{step + 1}</button>
          )
        })}
      </div>
      <label className="mpc-step-velocity">Step velocity
        <input aria-label="Step velocity" title="Velocity of the selected step. Turn the step on, then set how hard it hits." type="range" min={0.01} max={1} step={0.01} value={(() => {
          const sequence = kit.sequences[0]
          const beats = (sequence?.lengthBeats || 4) / 16
          return stepVelocity(sequence?.notes ?? [], pads[selected]?.pitch ?? 0, stepPick, beats) ?? kit.velocityFixed
        })()} onChange={(event) => store.setMpcStepVelocity(trackId, bank, selected, stepPick, Number(event.target.value))} />
      </label>
      <div className="mpc-body">
        <div className="mpc-play">
        <button
          type="button"
          className={`mpc-full ch-raised${kit.fullLevel ? ' on' : ''}`}
          aria-pressed={kit.fullLevel}
          title="Full level. Every hit plays at velocity 127, wherever you touch the pad."
          onClick={() => store.patchTrackKit(trackId, { fullLevel: !kit.fullLevel })}
        >Full level</button>
        <div className="mpc-grid" ref={board} aria-label="Drum pads">
          {pads.map((pad, index) => {
            const pitch = levels && source ? source.pitch : pad.pitch
            const label = levels ? levelLabel(index, levels) : padFaceName(pad)
            const sampleTitle = pad.sampleName || (pad.layers[0]?.bufferId ? store.buffers.get(pad.layers[0].bufferId)?.name : '') || pad.name
            const velocity = meters[index] ?? 0
            const lit = litPads.includes(index) || litNotes.includes(pitch) || velocity > 0.08
            return (
              <button
                key={`${bank}-${pad.pitch}-${index}`}
                type="button"
                className={`mpc-pad ch-raised${lit ? ' lit' : ''}${selected === index ? ' sel' : ''}${pad.muted ? ' muted' : ''}`}
                data-pad={index}
                data-pitch={pitch}
                style={{ ['--vel' as string]: String(velocity) }}
                title={`${sampleTitle && sampleTitle !== label ? `${label}. ${sampleTitle}` : label}. Drag a sound here. Keys ${PAD_KEYS[index]?.replace('Digit', '').replace('Key', '') ?? ''}.`}
                onDragOver={(event) => {
                  if ([...event.dataTransfer.types].includes(SOUND_MIME) || event.dataTransfer.types.includes('text/plain')) event.preventDefault()
                }}
                onDrop={(event) => { void dropSound(index, event) }}
              >
                <span>{label}</span>
                <i className="mpc-meter" aria-hidden style={{ height: `${Math.round(velocity * 100)}%` }} />
              </button>
            )
          })}
        </div>
        </div>
        {source && (
          <aside className="mpc-params ch-recessed" aria-label="Pad settings" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
            <h3 title={source.sampleName || source.name}>{padFaceName(source)}</h3>
            <div className="mpc-side-meter" aria-label="Pad meter" style={{ ['--vel' as string]: String(meters[selected] ?? 0) }}>
              <i style={{ height: `${Math.round((meters[selected] ?? 0) * 100)}%` }} />
            </div>
            <label>Vol
              <input aria-label="Pad volume" title="How loud this pad is." type="range" min={0} max={1} step={0.01} value={source.level} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { level: Number(event.target.value) })} />
            </label>
            <label>Pan
              <input aria-label="Pad pan" title="Left or right for this pad." type="range" min={-1} max={1} step={0.01} value={source.pan} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { pan: Number(event.target.value) })} />
            </label>
            <label>Tune
              <input aria-label="Pad tune" title="Pitch of this pad, in semitones." type="range" min={-12} max={12} step={0.1} value={source.tune} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { tune: Number(event.target.value) })} />
            </label>
            <label>Decay
              <input aria-label="Pad decay" title="How long this pad rings." type="range" min={0.05} max={1} step={0.01} value={source.decay} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { decay: Number(event.target.value) })} />
            </label>
            <label>Attack
              <input aria-label="Attack" title="Fade in for this pad." type="range" min={0} max={1} step={0.01} value={source.attack} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { attack: Number(event.target.value) })} />
            </label>
            <label>Filter
              <input aria-label="Filter" title="Low-pass cutoff for this pad." type="range" min={0} max={1} step={0.01} value={source.filter} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { filter: Number(event.target.value) })} />
            </label>
            <label>Sensitivity
              <input aria-label="Velocity sensitivity" title="How much this pad follows how hard you hit. Zero uses the fixed velocity." type="range" min={0} max={1} step={0.01} value={source.velocitySense ?? 1} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { velocitySense: Number(event.target.value) })} />
            </label>
            <label>Send
              <input aria-label="Send" title="How much of this pad goes to the send." type="range" min={0} max={1} step={0.01} value={source.send} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { send: Number(event.target.value) })} />
            </label>
            <button type="button" className={`ch-tab${source.region?.reverse ? ' on' : ''}`} aria-pressed={!!source.region?.reverse} title="Play this pad backwards." onClick={() => store.updateTrackPad(trackId, bank, selected, { region: { ...(source.region ?? { start: 0, end: 1, loop: false, loopStart: 0, loopEnd: 1, reverse: false }), reverse: !source.region?.reverse } })}>Reverse</button>
            <button type="button" className={`ch-tab${source.region?.loop ? ' on' : ''}`} aria-pressed={!!source.region?.loop} title="Loop the sample window." onClick={() => store.updateTrackPad(trackId, bank, selected, { region: { ...(source.region ?? { start: 0, end: 1, loop: false, loopStart: 0, loopEnd: 1, reverse: false }), loop: !source.region?.loop } })}>Loop</button>
            <button type="button" className={`ch-tab${source.poly === 'mono' ? ' on' : ''}`} aria-pressed={source.poly === 'mono'} title="Mono retriggers this pad. Poly lets notes overlap." onClick={() => store.updateTrackPad(trackId, bank, selected, { poly: source.poly === 'mono' ? 'poly' : 'mono' })}>{source.poly === 'mono' ? 'Mono' : 'Poly'}</button>
            <label>Choke
              <input aria-label="Choke group" title="Pads in the same group cut each other. Hats use group 1." type="number" min={0} max={8} value={source.choke} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { choke: Number(event.target.value) })} />
            </label>
            <button type="button" className={`ch-tab${source.muted ? ' on' : ''}`} aria-pressed={!!source.muted} title="Mute this pad. The clip keeps its notes." onClick={() => store.updateTrackPad(trackId, bank, selected, { muted: !source.muted })}>{source.muted ? 'Muted' : 'Mute'}</button>
            <label>Swing
              <input aria-label="Swing" title="MPC swing for quantize and note repeat. 50 is straight. 75 is a hard shuffle." type="range" min={50} max={75} step={1} value={kit.swing} onChange={(event) => {
                const swing = Number(event.target.value)
                store.patchTrackKit(trackId, { swing, trackSwing: swing })
              }} />
            </label>
            {!phone && (
              <label>Out
                <select aria-label="Pad output" title="Play this pad on the track, or on a bus." value={source.busId || ''} onChange={(event) => store.updateTrackPad(trackId, bank, selected, { busId: event.target.value || undefined })}>
                  <option value="">Track</option>
                  {store.project.tracks.filter((track) => track.type === 'bus').map((bus) => (
                    <option key={bus.id} value={bus.id}>{bus.name}</option>
                  ))}
                </select>
              </label>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function levelLabel(index: number, spread: LevelSpread) {
  const params = sixteenLevels(index, spread)
  if (spread === 'velocity') return String(Math.round(params.velocity * 127))
  if (spread === 'tune') return `${params.tune > 0 ? '+' : ''}${Math.round(params.tune)}`
  if (spread === 'filter') return String(Math.round(params.filter * 100))
  if (spread === 'decay') return String(Math.round(params.decay * 100))
  return String(Math.round(params.attack * 100))
}
