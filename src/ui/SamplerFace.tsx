import { useEffect, useRef } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { SamplerProgram } from '../audio/multisample/types'
import { noteName } from '../audio/sample/pitch'
import { scaledPeaks } from '../audio/sample/engine'
import type { ProjectStore } from '../state/store'
import { Keyboard, Knob } from './kit/controls'
import './kit/kit.css'

const LOOP = ['Loop', 'Ping', 'Once']

/** Playable zones, ignoring release triggers. */
export function playableZones(program: SamplerProgram) {
  return program.zones.filter((zone) => zone.trigger !== 'release' && zone.hikey >= zone.lokey)
}

/** "264 zones · A0–C8" for a multi-sample instrument, or the single root. */
export function zoneSummary(program: SamplerProgram) {
  const zones = playableZones(program)
  if (!zones.length) return 'No zones yet'
  const lo = Math.min(...zones.map((zone) => zone.lokey))
  const hi = Math.max(...zones.map((zone) => zone.hikey))
  if (zones.length === 1) return `Root ${noteName(zones[0].root)}`
  return `${zones.length} zones · ${noteName(lo)}–${noteName(hi)}`
}

export function SamplerFace({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const track = store.track(trackId)
  if (!track) return null
  const sampler = track.plugins.find((plugin) => plugin.pluginId === 'sampler' && plugin.sampler?.bufferId)
  const program = track.instrument === 'library' ? track.library : undefined
  const sampleName = sampler?.sampler?.bufferId ? store.buffers.get(sampler.sampler.bufferId)?.name : ''
  const channel = sampler?.sampler?.bufferId ? store.buffers.get(sampler.sampler.bufferId)?.channels[0] : undefined
  const zones = program ? playableZones(program) : []
  const multi = zones.length > 1
  const play = (note: number, velocity = 0.85) => {
    engine.unlock()
    engine.previewRack(track.id, note, false, true, velocity)
  }
  const samplerParam = (id: string, value: number) => {
    if (!sampler) return
    store.updatePlugin(track.id, sampler.id, { params: { [id]: value } })
  }
  const title = program?.name || sampleName || track.name
  return (
    <section className="sampler-face" data-sampler="face" aria-label="Sampler">
      <p className="sampler-title">{title}</p>
      {program ? (
        <ZoneMap program={program} />
      ) : (
        <div className="sampler-wave">
          <SampleWave channel={channel} />
        </div>
      )}
      <p className="sampler-zones-label">{program ? zoneSummary(program) : (sampleName || 'No sample yet')}</p>
      <div className="inst-knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
        {track.instrument === 'sampler' && sampler?.sampler ? (
          <>
            <RootStep label="Root" value={sampler.sampler.root} onChange={(root) => store.setSamplerRoot(track.id, root)} />
            <Knob label="Attack" min={1} max={2000} value={sampler.params.attack ?? 6} fallback={6} unit="ms" onChange={(value) => samplerParam('attack', value)} />
            <Knob label="Decay" min={5} max={3000} value={sampler.params.decay ?? 200} fallback={200} unit="ms" onChange={(value) => samplerParam('decay', value)} />
            <Knob label="Sustain" min={0} max={1} value={sampler.params.sustain ?? 0.85} fallback={0.85} onChange={(value) => samplerParam('sustain', value)} />
            <Knob label="Release" min={5} max={4000} value={sampler.params.release ?? 180} fallback={180} unit="ms" onChange={(value) => samplerParam('release', value)} />
            <Knob label="Tone" min={80} max={16000} value={sampler.params.cutoff ?? 16000} fallback={16000} unit="Hz" onChange={(value) => samplerParam('cutoff', value)} />
          </>
        ) : program ? (
          <LibraryKnobs store={store} trackId={track.id} multi={multi} />
        ) : null}
      </div>
      <div className="inst-row">
        {track.instrument === 'sampler' && sampler?.sampler ? (
          <button
            type="button"
            className={`bevel${sampler.sampler.loopMode === 0 ? ' on' : ''}`}
            title="Loop the sample, bounce it, or play it once."
            onClick={() => store.setSamplerLoop(track.id, ((sampler.sampler?.loopMode ?? 2) + 1) % 3)}
          >{LOOP[sampler.sampler.loopMode] ?? 'Once'}</button>
        ) : program ? (
          <LibraryLoop store={store} trackId={track.id} program={program} />
        ) : null}
      </div>
      <Keyboard compact onDown={(note, velocity) => play(note, velocity)} onUp={(note) => engine.releaseRack(track.id, note)} />
    </section>
  )
}

function LibraryKnobs({ store, trackId, multi }: { store: ProjectStore; trackId: string; multi: boolean }) {
  const program = store.track(trackId)?.library
  if (!program) return null
  const zone = playableZones(program)[0] ?? program.zones[0]
  const play = program.play ?? {
    tune: 0,
    attack: zone?.ampeg.attack ?? 0.004,
    decay: zone?.ampeg.decay ?? 0.2,
    sustain: zone?.ampeg.sustain ?? 0.85,
    release: zone?.ampeg.release ?? 0.2,
    tone: 20000,
  }
  const set = (patch: Partial<typeof play>) => store.setInstrumentPlay(trackId, patch)
  const root = Math.max(0, Math.min(127, Math.round((zone?.root ?? 60) + play.tune)))
  return (
    <>
      {multi ? (
        <RootStep label="Tune" value={60 + play.tune} onChange={(note) => set({ tune: note - 60 })} />
      ) : (
        <RootStep label="Root" value={root} onChange={(note) => set({ tune: note - (zone?.root ?? 60) })} />
      )}
      <Knob label="Attack" min={0} max={2} value={play.attack} fallback={0.004} unit="s" onChange={(attack) => set({ attack })} />
      <Knob label="Decay" min={0} max={4} value={play.decay} fallback={0.2} unit="s" onChange={(decay) => set({ decay })} />
      <Knob label="Sustain" min={0} max={1} value={play.sustain} fallback={0.85} onChange={(sustain) => set({ sustain })} />
      <Knob label="Release" min={0.01} max={4} value={play.release} fallback={0.2} unit="s" onChange={(release) => set({ release })} />
      <Knob label="Tone" min={80} max={20000} value={play.tone} fallback={20000} unit="Hz" onChange={(tone) => set({ tone })} />
    </>
  )
}

function LibraryLoop({ store, trackId, program }: { store: ProjectStore; trackId: string; program: SamplerProgram }) {
  const zones = playableZones(program)
  const looping = program.play?.loop ?? zones.some((zone) => zone.loopMode === 'loop' || zone.loopMode === 'sustain')
  return (
    <button
      type="button"
      className={`bevel${looping ? ' on' : ''}`}
      title="Loop the samples, or play each zone once."
      onClick={() => store.setInstrumentPlay(trackId, { loop: !looping })}
    >{looping ? 'Loop' : 'Once'}</button>
  )
}

function ZoneMap({ program }: { program: SamplerProgram }) {
  const zones = playableZones(program)
  if (!zones.length) return <div className="sampler-wave" aria-label="No zones yet" />
  const lo = Math.min(...zones.map((zone) => zone.lokey))
  const hi = Math.max(...zones.map((zone) => zone.hikey))
  const span = Math.max(1, hi - lo)
  return (
    <div className="sampler-wave sampler-zones" aria-label={zoneSummary(program)}>
      {zones.map((zone) => (
        <i
          key={zone.id}
          style={{
            left: `${((zone.lokey - lo) / span) * 100}%`,
            width: `${Math.max(0.4, ((zone.hikey - zone.lokey + 1) / span) * 100)}%`,
          }}
        />
      ))}
    </div>
  )
}

function SampleWave({ channel }: { channel?: Float32Array }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const width = canvas.clientWidth || 320
      const height = canvas.clientHeight || 72
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(width * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.strokeStyle = 'rgba(115, 196, 143, 0.35)'
      ctx.beginPath()
      ctx.moveTo(0, height / 2)
      ctx.lineTo(width, height / 2)
      ctx.stroke()
      if (!channel?.length) return
      const peaks = scaledPeaks(channel, Math.max(24, Math.floor(width / 3)))
      const bar = width / peaks.length
      ctx.fillStyle = '#8ee0ae'
      ctx.shadowColor = 'rgba(115, 196, 143, 0.85)'
      ctx.shadowBlur = 6
      peaks.forEach((peak, index) => {
        const top = (0.5 - peak.max * 0.46) * height
        const bottom = (0.5 - peak.min * 0.46) * height
        ctx.fillRect(index * bar, top, Math.max(1, bar - 1), Math.max(1, bottom - top))
      })
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [channel])
  return <canvas ref={ref} aria-label="Sample waveform" />
}

function RootStep({ label, value, onChange }: { label: string; value: number; onChange: (note: number) => void }) {
  const note = Math.max(0, Math.min(127, Math.round(value)))
  return (
    <div className="root-step" title={`${label}. The sample plays unchanged on this note. Other keys change the pitch.`}>
      <button type="button" className="bevel" aria-label={`Lower ${label}`} onClick={() => onChange(note - 1)}>−</button>
      <span>
        <em>{label}</em>
        <b>{noteName(note)}</b>
      </span>
      <button type="button" className="bevel" aria-label={`Raise ${label}`} onClick={() => onChange(note + 1)}>+</button>
    </div>
  )
}
