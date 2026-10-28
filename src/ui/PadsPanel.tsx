import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { Performer, pointerVelocity, type PerformTarget } from '../audio/performer'
import { ensureDefaultKit } from '../instruments/pads/load'
import { clipBeat, shortPadName } from '../instruments/pads/record'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { projectSampleBeat } from '../model/tempoMap'
import { BANKS, sixteenLevels, type LevelSpread } from '../model/padMachine'
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
  const [litPads, setLitPads] = useState<number[]>([])
  const [litNotes, setLitNotes] = useState<number[]>([])
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
  play.setGrid(repeatOn ? '1/16' : null, false)
  play.setEngaged(repeatOn)
  play.setQuantize(0)
  play.setDeck({
    kit,
    swing: kit.trackSwing,
    fullLevel: false,
    accent: false,
    erase: eraseOn,
    latch: false,
    levels: levels || null,
    fixedBeats: 0,
    recordMode: 'overdub',
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
      setSelected(index)
      play.down(pitch, pointerVelocity(event, key.getBoundingClientRect()), event.timeStamp, event.pointerId, levels ? index : undefined)
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
    root.addEventListener('pointerdown', down)
    root.addEventListener('pointerup', up)
    root.addEventListener('pointercancel', up)
    return () => {
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('pointerup', up)
      root.removeEventListener('pointercancel', up)
    }
  }, [levels, play])

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
      setSelected(index)
      play.down(pitch, 0.9, event.timeStamp, index + 1, levels ? index : undefined)
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
        <strong>Pads</strong>
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
          title="Hold for note repeat. The pad retriggers on 16ths."
          onPointerDown={(event) => { event.preventDefault(); setRepeatOn(true) }}
          onPointerUp={() => setRepeatOn(false)}
          onPointerCancel={() => setRepeatOn(false)}
          onPointerLeave={() => setRepeatOn(false)}
        >Repeat</button>
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
        <button type="button" className="ch-tab" title="Undo the last record pass." onClick={() => store.undoTake()}>Undo</button>
        <button type="button" className={`ch-tab${store.project.countIn ? ' on' : ''}`} aria-pressed={store.project.countIn} title="Count one bar before recording starts." onClick={() => store.toggle('countIn')}>Count</button>
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
        <button type="button" className="ch-tab mpc-close" title="Close Pads. The track keeps the instrument." aria-label="Close Pads. The track keeps the instrument." onClick={() => store.closePads()}>×</button>
      </div>
      <p className="mpc-tool ch-recessed" data-tool={tool}>Tool: <b>{tool}</b></p>
      <div className="mpc-body">
        <div className="mpc-grid" ref={board} aria-label="Drum pads">
          {pads.map((pad, index) => {
            const pitch = levels && source ? source.pitch : pad.pitch
            const label = levels ? levelLabel(index, levels) : shortPadName(pad.name)
            return (
              <button
                key={`${bank}-${pad.pitch}-${index}`}
                type="button"
                className={`mpc-pad ch-raised${litPads.includes(index) || litNotes.includes(pitch) ? ' lit' : ''}${selected === index ? ' sel' : ''}${pad.muted ? ' muted' : ''}`}
                data-pad={index}
                data-pitch={pitch}
                title={`${label}. Drag a sound here. Keys ${PAD_KEYS[index]?.replace('Digit', '').replace('Key', '') ?? ''}.`}
                onDragOver={(event) => {
                  if ([...event.dataTransfer.types].includes(SOUND_MIME) || event.dataTransfer.types.includes('text/plain')) event.preventDefault()
                }}
                onDrop={(event) => { void dropSound(index, event) }}
              >
                <span>{label}</span>
              </button>
            )
          })}
        </div>
        {source && (
          <aside className="mpc-params ch-recessed" aria-label="Pad settings">
            <h3>{shortPadName(source.name)}</h3>
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
