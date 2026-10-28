import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { normalizeChannel, peaks, syncedLoopSamples } from '../audio/sample/engine'
import {
  OPEN_SOUNDS,
  SLOT_ACCEPT,
  SLOT_CLIP,
  captureSlot,
  decodeSlotFile,
  dragSlotPoint,
  micChannel,
  openInputCapture,
  readSlotPoints,
  rememberedSlotInput,
  retargetSlices,
  type SlotPoints,
} from '../audio/sample/slot'
import { uid, type PluginInstance } from '../model/types'
import { readIdentity } from '../storage/identity'
import { samplesToBeats } from '../model/time'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { TipButton } from './Hint'
import './slot.css'

const PADS = Array.from({ length: 16 }, (_, index) => index)
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(midi: number) {
  const note = Math.round(midi)
  return `${NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`
}

export function SamplePanel({ store, engine, trackId, plugin }: { store: ProjectStore; engine: AudioEngine; trackId: string | 'master'; plugin: PluginInstance }) {
  const [more, setMore] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'count-in' | 'recording'>('idle')
  const [level, setLevel] = useState(0)
  const [countBeat, setCountBeat] = useState(0)
  const stopRef = useRef(false)
  const closeRef = useRef<(() => void) | null>(null)
  const sampler = plugin.sampler
  const looper = plugin.looper
  const bufferId = sampler?.bufferId || looper?.layers[0]?.bufferId || ''
  const asset = bufferId ? store.buffers.get(bufferId) : undefined
  const channel = asset?.channels[0]
  const points = readSlotPoints(sampler ?? looper)
  const phone = useFormFactor() === 'phone'
  const transport = selectTransport(store)
  const beat = () => samplesToBeats(engine.currentTimelineSample(), engine.sampleRate, transport.tempo)

  useEffect(() => () => {
    stopRef.current = true
    closeRef.current?.()
  }, [])

  useEffect(() => {
    if (plugin.pluginId !== 'looper') return
    const timer = window.setInterval(() => {
      const audio = engine.takeLoop(plugin.id)
      if (audio) store.addLooperLayer(trackId, plugin.id, audio)
    }, 240)
    return () => window.clearInterval(timer)
  }, [engine, plugin.id, plugin.pluginId, store, trackId])

  useEffect(() => {
    const onClip = (event: Event) => {
      const detail = (event as CustomEvent<{ trackId?: string; clipId?: string }>).detail
      if (!detail?.trackId || !detail.clipId) return
      if (!store.sendClipToSlot(trackId, plugin.id, detail.trackId, detail.clipId)) {
        store.toast('That clip has no audio to load.', 'warn')
      }
    }
    window.addEventListener(SLOT_CLIP, onClip)
    return () => window.removeEventListener(SLOT_CLIP, onClip)
  }, [plugin.id, store, trackId])

  const loadDecoded = (name: string, sampleRate: number, channels: Float32Array[], mode: 'replace' | 'overdub' = 'replace') => {
    store.loadSlotAudio(trackId, plugin.id, { id: uid('smp'), name, sampleRate, channels }, mode)
  }

  const onFile = async (file: File) => {
    try {
      const decoded = await decodeSlotFile(await file.arrayBuffer())
      if (!decoded.channels[0]?.length) {
        store.toast('That file had no audio.', 'warn')
        return
      }
      loadDecoded(file.name, decoded.sampleRate, decoded.channels)
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not read that audio file.', 'warn')
    }
  }

  const beginRecord = async (mode: 'replace' | 'overdub') => {
    if (phase !== 'idle') {
      stopRef.current = true
      return
    }
    stopRef.current = false
    const ctx = engine.unlock()
    const remembered = rememberedSlotInput()
    const deviceId = remembered.deviceId || readIdentity()?.micId || ''
    const input = trackId === 'master' ? undefined : store.track(trackId)?.input
    let capture: Awaited<ReturnType<typeof openInputCapture>>
    try {
      capture = await openInputCapture({
        deviceId,
        stream: remembered.stream,
        context: ctx,
        channel: micChannel(input),
        request: (audio) => navigator.mediaDevices.getUserMedia({ audio, video: false }),
      })
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not open the microphone.', 'warn')
      return
    }
    closeRef.current = capture.close
    if (capture.opened) engine.setLocalMic(capture.stream)
    if (mode === 'overdub' && looper?.layers.length) {
      store.updatePlugin(trackId, plugin.id, { looper: { ...looper, transport: 1 }, params: { transport: 1 } })
      engine.rewindLoop(plugin.id)
    }
    const maxSamples = looper && looper.sync !== false
      ? syncedLoopSamples(looper.bars || 1, store.project.tempo, capture.source.sampleRate, store.project.timeSignature.numerator)
      : 0
    try {
      const audio = await captureSlot(capture.source, {
        countIn: store.project.countIn,
        tempo: store.project.tempo,
        signature: store.project.timeSignature,
        maxSamples,
      }, {
        shouldStop: () => stopRef.current,
        onLevel: setLevel,
        onPhase: (next, count) => {
          setPhase(next)
          if (count) setCountBeat(count)
        },
        wait: (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms) }),
        click: () => { if (engine.ctx) engine.playCuePing(engine.ctx.currentTime) },
      })
      if (audio?.channels[0]?.length) {
        loadDecoded(mode === 'overdub' ? 'Overdub' : 'Recording', audio.sampleRate, audio.channels, mode)
      }
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Recording failed.', 'warn')
    } finally {
      capture.close()
      closeRef.current = null
      setPhase('idle')
      setLevel(0)
      setCountBeat(0)
    }
  }

  const sendSelected = () => {
    const clipId = store.selectedClipId
    const host = store.project.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
    if (!clipId || !host || !store.sendClipToSlot(trackId, plugin.id, host.id, clipId)) {
      store.toast('Select an arrange clip first.', 'warn')
    }
  }

  const setRoot = (root: number) => {
    if (!sampler) return
    const next = Math.max(0, Math.min(127, root))
    store.updatePlugin(trackId, plugin.id, { sampler: { ...sampler, root: next, slices: retargetSlices(sampler.slices, next) } })
  }

  const recording = phase !== 'idle'
  const recordLabel = recording ? 'Stop' : 'Record'
  const recordHint = recording ? 'Stop and keep what was recorded.' : 'Record the selected mic into this slot, after the count-in.'

  return (
    <div
      className="sample-panel slot-panel"
      data-slot-drop="1"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file) void onFile(file)
      }}
    >
      <SlotWave
        channel={channel}
        points={points}
        onDrag={(next) => store.setSlotPoints(trackId, plugin.id, next)}
        onDone={() => store.endDraft()}
      />
      {(recording || level > 0) && (
        <>
          <div className="slot-meter" aria-hidden="true"><span style={{ width: `${Math.round(level * 100)}%` }} /></div>
          <p className="slot-status">{phase === 'count-in' ? `Count-in ${countBeat}` : 'Recording'}</p>
        </>
      )}
      <div className="row">
        <TipButton className={recording ? 'on' : ''} label={recordLabel} hint={recordHint} pressed={recording} onClick={() => void beginRecord('replace')} />
        <label className="text-btn slot-upload" title="Load a wav, mp3, m4a, ogg, flac, or aiff file from this device.">
          Upload
          <input
            className="slot-file"
            type="file"
            accept={SLOT_ACCEPT}
            aria-label="Upload. Load a wav, mp3, m4a, ogg, flac, or aiff file from this device."
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void onFile(file)
            }}
          />
        </label>
        <TipButton label="Sounds" hint="Open the sound library and put one in this slot." onClick={() => window.dispatchEvent(new Event(OPEN_SOUNDS))} />
        {sampler && <TipButton className={plugin.params.keys >= 0.5 ? 'on' : ''} label="Keys" hint="Play the sample from the keyboard instead of the pads." pressed={plugin.params.keys >= 0.5} onClick={() => store.updatePlugin(trackId, plugin.id, { params: { keys: plugin.params.keys >= 0.5 ? 0 : 1 } })} />}
        {looper && !phone && <TipButton label="Dub" hint="Record another pass over the loop." onClick={() => void beginRecord('overdub')} />}
        {looper && <TipButton label="Play" hint="Play the loop from the next bar." onClick={() => store.armLooper(trackId, plugin.id, 1, beat())} />}
        {looper && <TipButton label="Stop" hint="Stop the loop." onClick={() => { stopRef.current = true; store.armLooper(trackId, plugin.id, 0, beat()) }} />}
        <TipButton className={more ? 'on' : ''} label="More" hint="Trim, normalize, slices, and the clip send." pressed={more} onClick={() => setMore((value) => !value)} />
      </div>
      {channel && (
        <div className="row">
          <TipButton label="Trim" hint="Cut to the start and end handles. A full selection trims silence." onClick={() => {
            if (sampler && points.start <= 0.001 && points.end >= 0.999) {
              store.editSample(trackId, plugin.id, 'trim')
              return
            }
            const from = Math.floor(points.start * channel.length)
            const to = Math.max(from + 2, Math.floor(points.end * channel.length))
            const rate = asset?.sampleRate || store.project.sampleRate
            loadDecoded(asset?.name || 'Trimmed', rate, (asset?.channels ?? [channel]).map((item) => item.slice(from, Math.min(item.length, to))))
          }} />
          <TipButton label="Norm" hint="Raise the sample so its peak is just under full level." onClick={() => {
            if (sampler) store.editSample(trackId, plugin.id, 'norm')
            else loadDecoded(asset?.name || 'Loop', asset?.sampleRate || store.project.sampleRate, [normalizeChannel(channel)])
          }} />
        </div>
      )}
      {sampler && (plugin.params.keys >= 0.5 ? (
        <div className="pads keys">
          {['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'].map((label, index) => {
            const note = [60, 62, 64, 65, 67, 69, 71, 72][index]
            return <TipButton key={label + index} label={label} hint={`Play ${label}.`} onClick={() => engine.previewSample(plugin.id, note)} />
          })}
        </div>
      ) : (
        <div className="pads">
          {PADS.map((pad) => (
            <TipButton key={pad} label={sampler.slices[pad] ? noteName(sampler.slices[pad].root) : String(pad + 1)} hint={`Play pad ${pad + 1}.`} onClick={() => engine.previewSample(plugin.id, sampler.slices[pad]?.root ?? 36 + pad)} />
          ))}
        </div>
      ))}
      {more && (
        <div className="row">
          <TipButton label="Clip" hint="Copy the selected arrange clip into this slot." onClick={sendSelected} />
          {looper && phone && <TipButton label="Dub" hint="Record another pass over the loop." onClick={() => void beginRecord('overdub')} />}
          {sampler && <TipButton label="Slice" hint="Cut the sample into pads across the keyboard." onClick={() => store.chopSample(trackId, plugin.id, 'grid')} />}
          {sampler && <TipButton label="Hits" hint="Cut the sample at the transients." onClick={() => store.chopSample(trackId, plugin.id, 'transient')} />}
          {sampler && <TipButton label="Beat" hint="Cut the sample on each beat." onClick={() => store.chopSample(trackId, plugin.id, 'beat')} />}
          {sampler && <TipButton label="MIDI" hint="Write the slices as notes on a MIDI clip." onClick={() => store.exportSlices(trackId, plugin.id)} />}
          {sampler && <TipButton label={noteName(sampler.root)} hint="Move the root note up one semitone. Pads follow this note." onClick={() => setRoot(sampler.root + 1)} />}
          {sampler && <TipButton label="Down" hint="Move the root note down one semitone." onClick={() => setRoot(sampler.root - 1)} />}
          {sampler && <TipButton label="Rev" hint="Reverse the sample." onClick={() => store.editSample(trackId, plugin.id, 'reverse')} />}
          {looper && <TipButton label={`${looper.bars} bar`} hint="Set how many bars the synced loop records." onClick={() => store.updatePlugin(trackId, plugin.id, { looper: { ...looper, bars: looper.bars >= 8 ? 1 : looper.bars + 1 } })} />}
          {looper && <TipButton className={looper.sync ? 'on' : ''} label="Sync" hint="Record a whole number of bars at the song tempo." pressed={looper.sync} onClick={() => store.updatePlugin(trackId, plugin.id, { looper: { ...looper, sync: !looper.sync } })} />}
          {looper && <TipButton label="Undo" hint="Remove the last loop layer." onClick={() => store.undoLooper(trackId, plugin.id)} />}
          {looper && <TipButton label="Redo" hint="Put the last removed layer back." onClick={() => store.redoLooper(trackId, plugin.id)} />}
          {looper && <TipButton label="Clear" hint="Remove every loop layer." onClick={() => store.clearLooper(trackId, plugin.id)} />}
          {looper && trackId !== 'master' && <TipButton label="Bounce" hint="Put the mixed loop on the arrange track." onClick={() => store.bounceLooper(trackId, plugin.id, engine.currentTimelineSample())} />}
        </div>
      )}
    </div>
  )
}

function SlotWave({
  channel,
  points,
  onDrag,
  onDone,
}: {
  channel: Float32Array | undefined
  points: SlotPoints
  onDrag: (points: SlotPoints) => void
  onDone: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const view = canvas.current
    const ctx = view?.getContext('2d')
    if (!view || !ctx) return
    const width = view.width
    const height = view.height
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#73c48f'
    const bars = channel ? peaks(channel, 64) : []
    bars.forEach((bar, index) => {
      const mid = height / 2
      const top = mid - bar.max * mid
      const heightBar = Math.max(1, (bar.max - bar.min) * mid)
      ctx.fillRect(index * (width / 64), top, Math.max(1, width / 64 - 1), heightBar)
    })
  }, [channel])
  const move = (which: keyof SlotPoints) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const host = box.current
    if (!host) return
    event.preventDefault()
    const pointer = event.pointerId
    host.setPointerCapture(pointer)
    const at = (clientX: number) => {
      const rect = host.getBoundingClientRect()
      return (clientX - rect.left) / Math.max(1, rect.width)
    }
    onDrag(dragSlotPoint(points, which, at(event.clientX)))
    const drag = (ev: PointerEvent) => onDrag(dragSlotPoint(points, which, at(ev.clientX)))
    const up = () => {
      host.removeEventListener('pointermove', drag)
      host.removeEventListener('pointerup', up)
      onDone()
    }
    host.addEventListener('pointermove', drag)
    host.addEventListener('pointerup', up)
  }
  const left = (value: number) => `${value * 100}%`
  return (
    <div ref={box} className="slot-wave" aria-label="Waveform. Drag the handles to set the start, end, and loop points.">
      <canvas ref={canvas} width={320} height={72} />
      <i className="slot-shade" style={{ left: 0, width: left(points.start) }} />
      <i className="slot-shade" style={{ left: left(points.end), right: 0 }} />
      <button type="button" className="slot-handle" style={{ left: left(points.start) }} aria-label="Start. Drag to set where the sample begins." title="Drag to set where the sample begins." onPointerDown={move('start')}><i /></button>
      <button type="button" className="slot-handle loop" style={{ left: left(points.loopStart) }} aria-label="Loop start. Drag to set where the loop repeats." title="Drag to set where the loop repeats." onPointerDown={move('loopStart')}><i /></button>
      <button type="button" className="slot-handle loop" style={{ left: left(points.loopEnd) }} aria-label="Loop end. Drag to set where the loop returns." title="Drag to set where the loop returns." onPointerDown={move('loopEnd')}><i /></button>
      <button type="button" className="slot-handle" style={{ left: left(points.end) }} aria-label="End. Drag to set where the sample ends." title="Drag to set where the sample ends." onPointerDown={move('end')}><i /></button>
    </div>
  )
}
