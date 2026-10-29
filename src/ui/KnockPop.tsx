import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { CLICK_NAMES, DRIVE_NAMES, knockPadPitch, noteLabel, NOTE_NAMES, renderKnockBuffer, SCALE_NAMES, detectPitch } from '../audio/rack/knock'
import { KNOCK_PRESETS } from '../model/knockPresets'
import { activeDevicePreset } from '../model/rack'
import { PresetBar } from './PresetBar'
import { samplesToBeats } from '../model/time'
import { uid } from '../model/types'
import { selectKnock } from '../state/select'
import type { ProjectStore } from '../state/store'

const MACROS = [
  { id: 'punch', name: 'Punch', min: 0, max: 24, step: 0.1 },
  { id: 'decay', name: 'Decay', min: 20, max: 2400, step: 1 },
  { id: 'glide', name: 'Glide', min: 0, max: 1000, step: 1 },
  { id: 'drive', name: 'Drive', min: 0, max: 1, step: 0.01 },
  { id: 'cutoff', name: 'Tone', min: 80, max: 12000, step: 1 },
  { id: 'sub', name: 'Sub', min: 0, max: 1, step: 0.01 },
] as const

function goertzel(samples: Float32Array, freq: number, sampleRate: number) {
  const n = samples.length
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n
}

export function KnockPop({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const [, setTick] = useState(0)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const curveRef = useRef<HTMLCanvasElement>(null)
  const specRef = useRef<HTMLCanvasElement>(null)
  const padsRef = useRef<HTMLDivElement>(null)
  const tunerRef = useRef<HTMLParagraphElement>(null)
  const slideRef = useRef(false)
  const [slideArm, setSlideArm] = useState(false)
  const [played, setPlayed] = useState(36)
  const playedRef = useRef(setPlayed)
  playedRef.current = setPlayed
  slideRef.current = slideArm
  useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store])
  const knock = selectKnock(store)
  const track = knock.track
  const device = knock.device
  const params = device?.params
  const api = useRef({ trackId: track?.id || '', legato: true, fine: 0, root: 0, scale: 0 })
  if (track && params) {
    api.current = {
      trackId: track.id,
      legato: (params.legato ?? 1) >= 0.5,
      fine: params.fine || 0,
      root: params.root || 0,
      scale: params.scale || 0,
    }
  }

  const signature = params ? JSON.stringify(params) : ''
  useEffect(() => {
    if (!params || !waveRef.current || !specRef.current || !curveRef.current) return
    const rendered = renderKnockBuffer(params, [{ sample: 0, pitch: 36, vel: 0.9 }], 48000, store.project.tempo, 2048)
    drawWave(waveRef.current, rendered.left)
    drawSpectrum(specRef.current, rendered.left)
    drawCurve(curveRef.current, params.punch || 0, params.pdec || 40, params.pcurve || 0)
  }, [signature, store.project.tempo])

  useEffect(() => {
    const root = padsRef.current
    if (!root || !track) return
    const pointers = new Map<number, { pitch: number; pad: HTMLButtonElement }>()
    const padOf = (event: Event) => (event.target as HTMLElement).closest('button[data-pitch]') as HTMLButtonElement | null
    const down = (event: PointerEvent) => {
      if (pointers.has(event.pointerId)) return
      const pad = padOf(event)
      if (!pad || !root.contains(pad)) return
      event.preventDefault()
      const pitch = Number(pad.dataset.pitch)
      const info = api.current
      const slide = slideRef.current && pointers.size > 0
      pointers.set(event.pointerId, { pitch, pad })
      const ctx = engine.ctx
      const perfNow = performance.now()
      const stamp = ctx?.getOutputTimestamp?.()
      const stamped = stamp?.performanceTime
      const perf = stamped != null && Math.abs(stamped - perfNow) <= 5 ? stamped : perfNow
      engine.previewRack(info.trackId, pitch, slide, true)
      playedRef.current(pitch)
      try { pad.setPointerCapture(event.pointerId) } catch { /* synthetic events have no pointer */ }
      if (tunerRef.current) {
        const key = `${NOTE_NAMES[Math.round(info.root) % 12] || 'C'} ${SCALE_NAMES[Math.round(info.scale)] || 'Major'}`
        tunerRef.current.textContent = `${noteLabel(pitch + info.fine / 100)} · ${key}`
      }
      if (engine.status === 'recording') {
        const sample = engine.timelineSampleForPerf(perf)
        const beat = samplesToBeats(sample, engine.sampleRate, store.project.tempo)
        let clip = store.track(info.trackId)?.midiClips[0]
        if (!clip) {
          store.addMidiClip(info.trackId, 0)
          clip = store.track(info.trackId)?.midiClips.at(-1)
        }
        if (clip) {
          store.addNote(info.trackId, clip.id, {
            pitch,
            startBeat: Math.max(0, beat - clip.startBeat),
            durationBeats: 1,
            velocity: 0.9,
            slide,
          })
        }
      }
      pad.classList.add('on')
    }
    const up = (event: PointerEvent) => {
      const current = pointers.get(event.pointerId)
      if (!current) return
      pointers.delete(event.pointerId)
      const still = [...pointers.values()].some((item) => item.pitch === current.pitch)
      if (!still) engine.releaseRack(api.current.trackId, current.pitch)
      current.pad.classList.remove('on')
    }
    root.addEventListener('pointerdown', down)
    root.addEventListener('pointerup', up)
    root.addEventListener('pointercancel', up)
    return () => {
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('pointerup', up)
      root.removeEventListener('pointercancel', up)
    }
  }, [engine, store, track?.id])

  if (!track || !device || !params) return null
  const setParam = (id: string, value: number) => store.setDeviceParam(track.id, device.id, id, value)
  const pitches = Array.from({ length: 8 }, (_, index) => knockPadPitch(index, params.root || 0, params.scale || 0))
  const dragCurve = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const y = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height))
    setParam('pdec', 8 + x * 360)
    setParam('punch', y * 24)
  }
  return (
    <div className="knock-pop" data-knock="open">
      <header>
        <strong>Knock</strong>
        <PresetBar
          names={KNOCK_PRESETS.map((item) => item.name)}
          active={activeDevicePreset('knock', params)}
          onPick={(name) => store.applyDevicePreset(track.id, device.id, name)}
        />
        <button className={`text-btn ${slideArm ? 'on' : ''}`} onClick={() => setSlideArm((value) => !value)}>Slide</button>
        <button className={`text-btn ${(params.snap || 0) >= 0.5 ? 'on' : ''}`} onClick={() => setParam('snap', (params.snap || 0) >= 0.5 ? 0 : 1)}>Key</button>
        <button className="text-btn" onClick={onClose}>Close</button>
      </header>
      <div className="knock-stage">
        <div className="knock-controls" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
          <div className="knock-macros">
            {MACROS.map((macro) => (
              <label key={macro.id}>
                {macro.name}
                <input
                  type="range"
                  min={macro.min}
                  max={macro.max}
                  step={macro.step}
                  value={params[macro.id] ?? macro.min}
                  aria-label={macro.name}
                  onChange={(event) => setParam(macro.id, Number(event.target.value))}
                />
              </label>
            ))}
          </div>
          <div className="knock-meters">
            <canvas ref={waveRef} className="knock-wave" width={320} height={72} aria-label="Waveform" />
            <canvas
              ref={curveRef}
              className="knock-curve"
              width={320}
              height={72}
              aria-label="Pitch envelope"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                dragCurve(event)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) dragCurve(event)
              }}
            />
            <canvas ref={specRef} className="knock-spec" width={320} height={72} aria-label="Spectrum" />
          </div>
          <p className="knock-tuner" ref={tunerRef}>
            {noteLabel(played + (params.fine || 0) / 100)} · {NOTE_NAMES[Math.round(params.root || 0) % 12]} {SCALE_NAMES[Math.round(params.scale || 0)]}
          </p>
          <div className="knock-row">
            <label>
              Shape
              <input type="range" min={0} max={1} step={0.01} value={params.morph || 0} aria-label="Shape" onChange={(event) => setParam('morph', Number(event.target.value))} />
            </label>
            <label>
              Drive
              <select aria-label="Drive type" value={Math.round(params.dtype || 0)} onChange={(event) => setParam('dtype', Number(event.target.value))}>
                {DRIVE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </label>
            <label>
              Click
              <select aria-label="Click" value={Math.round(params.click || 0)} onChange={(event) => setParam('click', Number(event.target.value))}>
                {CLICK_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </label>
            <label>
              Duck
              <input type="range" min={0} max={1} step={0.01} value={params.duck || 0} aria-label="Duck from kick" onChange={(event) => setParam('duck', Number(event.target.value))} />
            </label>
            <label>
              Sample
              <input
                aria-label="Load sample"
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  void loadKnockSample(store, engine, track.id, device.id, file)
                }}
              />
            </label>
          </div>
        </div>
        <div className="knock-play" ref={padsRef}>
          {pitches.map((pitch) => (
            <button key={pitch} type="button" data-pitch={pitch} className="knock-pad">
              {noteLabel(pitch).split(' ')[0]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

async function loadKnockSample(store: ProjectStore, engine: AudioEngine, trackId: string, deviceId: string, file: File) {
  const ctx = engine.ctx ?? new AudioContext()
  const audio = await ctx.decodeAudioData((await file.arrayBuffer()).slice(0))
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index).slice())
  const found = detectPitch(channels[0], audio.sampleRate)
  const id = uid('buf')
  store.addAsset({ id, name: file.name, sampleRate: audio.sampleRate, channels })
  store.addZone(trackId, deviceId, id)
  store.setDeviceParam(trackId, deviceId, 'smode', 1)
  store.setDeviceParam(trackId, deviceId, 'sroot', found.midi || 36)
}

function drawWave(canvas: HTMLCanvasElement, samples: Float32Array) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = '#73c48f'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let x = 0; x < width; x++) {
    const index = Math.floor((x / width) * samples.length)
    const y = height / 2 - (samples[index] || 0) * (height * 0.45)
    if (x === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function drawCurve(canvas: HTMLCanvasElement, punch: number, decayMs: number, curve: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = '#e0b15a'
  ctx.lineWidth = 2
  ctx.beginPath()
  const span = Math.max(40, decayMs)
  for (let x = 0; x < width; x++) {
    const t = Math.min(1, (x / width) * (360 / span))
    const shaped = curve >= 1.5 ? t * t * (3 - 2 * t) : curve >= 0.5 ? 1 - (1 - t) ** 2 : t
    const semis = punch * (1 - Math.min(1, shaped))
    const y = height - 4 - (semis / 24) * (height - 8)
    if (x === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function drawSpectrum(canvas: HTMLCanvasElement, samples: Float32Array) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  const bins = [45, 70, 100, 160, 260, 500, 1000, 2000, 4000, 7000]
  bins.forEach((freq, index) => {
    const mag = goertzel(samples, freq, 48000)
    const bar = Math.min(height - 2, mag * height * 8)
    ctx.fillStyle = freq < 140 ? '#79b8d4' : '#73c48f'
    const w = width / bins.length - 4
    ctx.fillRect(index * (width / bins.length) + 2, height - bar, w, bar)
  })
}
