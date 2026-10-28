import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { peaks, syncedLoopSamples } from '../audio/sample/engine'
import {
  OPEN_SOUNDS,
  SLOT_ACCEPT,
  SLOT_CLIP,
  audibleLoopSamples,
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
  const [take, setTake] = useState<'replace' | 'overdub' | null>(null)
  const [level, setLevel] = useState(0)
  const [countBeat, setCountBeat] = useState(0)
  const stopRef = useRef(false)
  const busyRef = useRef(false)
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
    if (phase !== 'idle' || busyRef.current) {
      stopRef.current = true
      return
    }
    stopRef.current = false
    busyRef.current = true
    setTake(mode)
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
      busyRef.current = false
      setTake(null)
      store.toast(error instanceof Error ? error.message : 'Could not open the microphone.', 'warn')
      return
    }
    closeRef.current = capture.close
    if (capture.opened) {
      try { engine.setLocalMic(capture.stream) } catch { /* the slot is already listening to this stream */ }
    }
    const overdub = mode === 'overdub' && !!looper?.layers.length
    const fullBar = looper && looper.sync !== false
      ? syncedLoopSamples(looper.bars || 1, store.project.tempo, capture.source.sampleRate, store.project.timeSignature.numerator)
      : 0
    const sourceRate = looper?.sourceRate && looper.sourceRate > 0 ? looper.sourceRate : capture.source.sampleRate
    const maxSamples = overdub && looper && looper.lengthSamples > 0
      ? audibleLoopSamples(looper.lengthSamples, readSlotPoints(looper), sourceRate, capture.source.sampleRate)
      : fullBar
    const hearLoop = () => {
      if (!overdub) return
      const list = trackId === 'master' ? store.project.masterPlugins : store.track(trackId)?.plugins
      const live = list?.find((item) => item.id === plugin.id)?.looper
      if (!live?.layers.length) return
      store.updatePlugin(trackId, plugin.id, { looper: { ...live, transport: 1 }, params: { transport: 1 } })
      engine.rewindLoop(plugin.id)
    }
    if (!store.project.countIn) hearLoop()
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
          if (next === 'recording' && store.project.countIn) hearLoop()
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
      busyRef.current = false
      setTake(null)
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
  const dubbing = recording && take === 'overdub'
  const recordLabel = recording && !dubbing ? 'Stop' : 'Record'
  const recordHint = recording && !dubbing ? 'Stop and keep what was recorded.' : 'Record the selected mic into this slot, after the count-in.'
  const stopTake = () => { stopRef.current = true }

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
        <TipButton className={recording && !dubbing ? 'on' : ''} label={recordLabel} hint={recordHint} pressed={recording && !dubbing} onClick={() => { if (recording) stopTake(); else void beginRecord('replace') }} />
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
        {looper && !phone && <TipButton className={dubbing ? 'on' : ''} label={dubbing ? 'Stop' : 'Dub'} hint={dubbing ? 'Stop and keep this pass.' : 'Record another pass over the loop. The loop restarts with the pass.'} pressed={dubbing} onClick={() => { if (recording) stopTake(); else void beginRecord('overdub') }} />}
        {looper && <TipButton label="Play" hint="Play the loop from the next bar." onClick={() => store.armLooper(trackId, plugin.id, 1, beat())} />}
        {looper && <TipButton label="Stop" hint="Stop the loop." onClick={() => { stopRef.current = true; store.armLooper(trackId, plugin.id, 0, beat()) }} />}
        <TipButton className={more ? 'on' : ''} label="More" hint="Trim, normalize, slices, and the clip send." pressed={more} onClick={() => setMore((value) => !value)} />
      </div>
      {channel && (
        <div className="row">
          <TipButton label="Trim" hint="Cut to the start and end handles. A full selection trims silence." onClick={() => {
            if (looper) {
              if (points.start <= 0.001 && points.end >= 0.999) {
                store.toast('Drag the start or end handle, then trim.', 'info')
                return
              }
              store.trimLooperWindow(trackId, plugin.id)
              return
            }
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
            else store.normalizeLooper(trackId, plugin.id)
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
          {looper && phone && <TipButton className={dubbing ? 'on' : ''} label={dubbing ? 'Stop' : 'Dub'} hint={dubbing ? 'Stop and keep this pass.' : 'Record another pass over the loop. The loop restarts with the pass.'} pressed={dubbing} onClick={() => { if (recording) stopTake(); else void beginRecord('overdub') }} />}
          {sampler && <TipButton label="Slice" hint="Cut the sample into pads across the keyboard." onClick={() => store.chopSample(trackId, plugin.id, 'grid')} />}
          {sampler && <TipButton label="Hits" hint="Cut the sample at the transients." onClick={() => store.chopSample(trackId, plugin.id, 'transient')} />}
          {sampler && <TipButton label="Beat" hint="Cut the sample on each beat." onClick={() => store.chopSample(trackId, plugin.id, 'beat')} />}
          {sampler && <TipButton label="MIDI" hint="Write the slices as notes on a MIDI clip." onClick={() => store.exportSlices(trackId, plugin.id)} />}
          {sampler && <TipButton label={noteName(sampler.root)} hint="Move the root note up one semitone. Pads follow this note." onClick={() => setRoot(sampler.root + 1)} />}
          {sampler && <TipButton label="Down" hint="Move the root note down one semitone." onClick={() => setRoot(sampler.root - 1)} />}
          {sampler && <TipButton label="Snap" hint="Move the handles to the nearest zero crossing." onClick={() => store.editSample(trackId, plugin.id, 'snap')} />}
          {sampler && <TipButton label="Fade" hint="Fade the sample in and out so the edges stay quiet." onClick={() => store.editSample(trackId, plugin.id, 'fade')} />}
          {sampler && <TipButton label="Rev" hint="Reverse the sample." onClick={() => store.editSample(trackId, plugin.id, 'reverse')} />}
          {looper && <TipButton label="Half" hint="Play the last layer at half speed." onClick={() => {
            const last = looper.layers[looper.layers.length - 1]
            const speed = (last?.speed || 1) < 1 ? 1 : 0.5
            store.updatePlugin(trackId, plugin.id, { params: { speed }, looper: { ...looper, layers: looper.layers.map((layer, index) => index === looper.layers.length - 1 ? { ...layer, speed } : layer) } })
          }} />}
          {looper && <TipButton label="Double" hint="Play the last layer at double speed." onClick={() => {
            const last = looper.layers[looper.layers.length - 1]
            const speed = (last?.speed || 1) > 1 ? 1 : 2
            store.updatePlugin(trackId, plugin.id, { params: { speed }, looper: { ...looper, layers: looper.layers.map((layer, index) => index === looper.layers.length - 1 ? { ...layer, speed } : layer) } })
          }} />}
          {looper && <TipButton label="Rev" hint="Reverse the last layer." onClick={() => store.updatePlugin(trackId, plugin.id, { looper: { ...looper, layers: looper.layers.map((layer, index) => index === looper.layers.length - 1 ? { ...layer, reverse: !layer.reverse } : layer) } })} />}
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

const HANDLE_COPY: Record<keyof SlotPoints, { name: string; label: string }> = {
  start: { name: 'Start', label: 'Start. Drag to set where the sample begins.' },
  end: { name: 'End', label: 'End. Drag to set where the sample ends.' },
  loopStart: { name: 'Loop start', label: 'Loop start. Drag to set where the loop repeats.' },
  loopEnd: { name: 'Loop end', label: 'Loop end. Drag to set where the loop returns.' },
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
  const [active, setActive] = useState<keyof SlotPoints | null>(null)
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
    const handle = event.currentTarget
    if (!host) return
    event.preventDefault()
    event.stopPropagation()
    const pointer = event.pointerId
    try { handle.setPointerCapture(pointer) } catch { /* the pointer can end before capture */ }
    setActive(which)
    const at = (clientX: number) => {
      const rect = host.getBoundingClientRect()
      return (clientX - rect.left) / Math.max(1, rect.width)
    }
    onDrag(dragSlotPoint(points, which, at(event.clientX)))
    const drag = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      ev.preventDefault()
      onDrag(dragSlotPoint(points, which, at(ev.clientX)))
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      handle.removeEventListener('pointermove', drag)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setActive(null)
      onDone()
    }
    handle.addEventListener('pointermove', drag)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const left = (value: number) => `${value * 100}%`
  const handle = (which: keyof SlotPoints, loop: boolean) => (
    <button
      type="button"
      className={`slot-handle ${loop ? 'loop' : 'edge'}${active === which ? ' on' : ''}`}
      style={{ left: left(points[which]) }}
      aria-label={HANDLE_COPY[which].label}
      title={HANDLE_COPY[which].label.replace(`${HANDLE_COPY[which].name}. `, '')}
      aria-pressed={active === which}
      onPointerDown={move(which)}
    >
      <i />
    </button>
  )
  return (
    <div ref={box} className="slot-wave" aria-label="Waveform. Drag the handles to set the start, end, and loop points.">
      <canvas ref={canvas} width={320} height={72} />
      <i className="slot-shade" style={{ left: 0, width: left(points.start) }} />
      <i className="slot-shade" style={{ left: left(points.end), right: 0 }} />
      <i className="slot-loop" style={{ left: left(points.loopStart), width: `${Math.max(0, points.loopEnd - points.loopStart) * 100}%` }} />
      {handle('start', false)}
      {handle('loopStart', true)}
      {handle('loopEnd', true)}
      {handle('end', false)}
      {active && <p className="slot-status slot-active">{HANDLE_COPY[active].name}</p>}
    </div>
  )
}
