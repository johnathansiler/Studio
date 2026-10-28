import { useEffect, useRef } from 'react'
import { TUNE_NAME, TUNE_PRESET_META, TUNE_PRESET_NAMES, tuneOnTrack } from '../audio/plugins/autoTune'
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
  const hint = plugin
    ? 'Open Auto-Tune. It is on this track and follows the project key unless you set one.'
    : 'Add Auto-Tune to this track. Starts in key, with an audible hard-tune preset.'
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

export function AutoTuneFace({
  values,
  trace,
  revision,
  enabled,
  projectKey,
  projectScale,
  active,
  presets,
  onChange,
  onScale,
  onPreset,
  onBypass,
}: {
  values: Record<string, number>
  trace: Float32Array | null
  revision: number
  enabled: boolean
  projectKey: string
  projectScale: string
  active?: string | null
  presets?: readonly string[]
  onChange: (id: string, value: number) => void
  onScale: (mode: number, scaleIndex: number) => void
  onPreset: (name: string) => void
  onBypass: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const heard = latestPair(trace)
  useEffect(() => {
    drawPitch(canvas.current, trace)
  }, [trace, revision])
  const scaleValue = (values.mode ?? 1) < 0.5 ? 'chromatic' : Math.round(values.scaleIndex ?? -1) < 0 ? 'project' : String(Math.round(values.scaleIndex ?? -1))
  const names = presets?.length ? presets : [...TUNE_PRESET_NAMES]
  return (
    <section className="autotune" aria-label={`${TUNE_NAME} faceplate`}>
      <div className="autotune-key">
        <label>
          <span>Key</span>
          <small>Project key, or a key just for this track.</small>
          <select
            aria-label={`Key. Project key is ${projectKey}. Pick a note to override it.`}
            title={`Project key is ${projectKey}. Pick a note to override it.`}
            value={Math.round(values.root ?? -1)}
            onChange={(event) => onChange('root', Number(event.target.value))}
          >
            <option value={-1}>Project · {projectKey}</option>
            {NOTE_NAMES.map((name, index) => (
              <option key={name} value={index}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Scale</span>
          <small>Project scale, a scale, or chromatic.</small>
          <select
            aria-label={`Scale. Project scale is ${projectScale}. Pick a scale or chromatic.`}
            title={`Project scale is ${projectScale}. Pick a scale or chromatic.`}
            value={scaleValue}
            onChange={(event) => {
              const next = event.target.value
              if (next === 'chromatic') onScale(0, -1)
              else if (next === 'project') onScale(1, -1)
              else onScale(1, Number(next))
            }}
          >
            <option value="project">Project · {projectScale}</option>
            <option value="chromatic">Chromatic</option>
            {SCALES.map((scale, index) => (
              <option key={scale.id} value={index}>{scale.name}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`autotune-bypass ${enabled ? '' : 'on'}`}
          aria-pressed={!enabled}
          title={enabled ? 'Bypass Auto-Tune. The track plays without pitch correction.' : 'Auto-Tune is bypassed. Turn it back on.'}
          aria-label={enabled ? 'Bypass. Turn Auto-Tune off for this track.' : 'Bypassed. Turn Auto-Tune back on.'}
          onClick={onBypass}
        >
          {enabled ? 'Bypass' : 'Bypassed'}
        </button>
      </div>
      <div className="autotune-graph">
        <canvas ref={canvas} width={640} height={160} aria-label="Detected pitch and corrected pitch" />
        <p>
          <i className="heard" /> Heard
          <i className="tuned" /> Tuned
          <strong>{heard ? `${noteLabel(heard.detected)} → ${noteLabel(heard.corrected)}` : 'Waiting for a note'}</strong>
        </p>
      </div>
      <div className="autotune-sliders">
        <Slider label="Retune Speed" hint="How fast the note snaps. Right is the hard-tune effect." value={values.retune ?? 0.95} min={0.02} max={1} step={0.01} text={retuneText(values.retune ?? 0.95)} onChange={(value) => onChange('retune', value)} />
        <Slider label="Humanize" hint="Leave a little of the original pitch in the note." value={values.humanize ?? 0.05} min={0} max={1} step={0.01} text={percent(values.humanize ?? 0.05)} onChange={(value) => onChange('humanize', value)} />
        <Slider label="Amount" hint="How much correction you hear. Zero is dry." value={values.amount ?? 0.85} min={0} max={1} step={0.01} text={percent(values.amount ?? 0.85)} onChange={(value) => onChange('amount', value)} />
        <Slider label="Formant" hint="Zero keeps the throat. Right lets the tone follow the new pitch." value={values.formant ?? 0} min={0} max={1} step={0.01} text={(values.formant ?? 0) < 0.08 ? 'Keep' : percent(values.formant ?? 0)} onChange={(value) => onChange('formant', value)} />
        <Slider label="Transpose" hint="Shift the corrected note, in semitones." value={values.transpose ?? 0} min={-12} max={12} step={1} text={semitones(values.transpose ?? 0)} onChange={(value) => onChange('transpose', value)} />
      </div>
      <div className="autotune-presets" role="group" aria-label="Auto-Tune presets">
        {names.map((name) => {
          const meta = TUNE_PRESET_META.find((item) => item.name === name)
          const hint = meta?.hint ?? 'Load this saved Auto-Tune preset.'
          const on = active === name
          return (
            <button
              key={name}
              type="button"
              className={on ? 'on' : ''}
              aria-pressed={on}
              data-preset={name}
              title={`${name}. ${hint}`}
              aria-label={`${name}. ${hint}`}
              onClick={() => onPreset(name)}
            >
              <span className="wide">{name}</span>
              <span className="narrow">{meta?.short ?? name}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  text,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  step: number
  text: string
  onChange: (value: number) => void
}) {
  return (
    <label className="autotune-slider">
      <span>{label}</span>
      <small>{hint}</small>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={`${label}. ${hint}`}
        title={hint}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <em>{text}</em>
    </label>
  )
}

function drawPitch(view: HTMLCanvasElement | null, trace: Float32Array | null) {
  const ctx = view?.getContext('2d')
  if (!view || !ctx) return
  const width = view.width
  const height = view.height
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#101814'
  ctx.fillRect(0, 0, width, height)
  const frames = framesOf(trace)
  const voiced = frames.filter((frame) => frame.detected > 0 || frame.corrected > 0)
  if (!voiced.length) {
    ctx.fillStyle = '#93a399'
    ctx.font = '14px sans-serif'
    ctx.fillText('Sing or play to see the pitch', 16, height / 2)
    return
  }
  const midis = voiced.flatMap((frame) => [frame.detected, frame.corrected].filter((hz) => hz > 0).map(midiOf))
  let low = Math.min(...midis) - 2
  let high = Math.max(...midis) + 2
  if (high - low < 12) {
    const mid = (high + low) / 2
    low = mid - 6
    high = mid + 6
  }
  const yOf = (midi: number) => height - ((midi - low) / (high - low)) * (height - 16) - 8
  ctx.strokeStyle = 'rgba(147, 163, 153, 0.25)'
  ctx.lineWidth = 1
  for (let midi = Math.ceil(low); midi <= high; midi++) {
    const y = yOf(midi)
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  stroke(ctx, frames, width, (frame) => (frame.detected > 0 ? yOf(midiOf(frame.detected)) : null), '#e0b15a')
  stroke(ctx, frames, width, (frame) => (frame.corrected > 0 ? yOf(midiOf(frame.corrected)) : null), '#73c48f')
}

function stroke(
  ctx: CanvasRenderingContext2D,
  frames: { detected: number; corrected: number }[],
  width: number,
  yOf: (frame: { detected: number; corrected: number }) => number | null,
  color: string,
) {
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  let drawing = false
  frames.forEach((frame, index) => {
    const y = yOf(frame)
    const x = (index / Math.max(1, frames.length - 1)) * width
    if (y == null) {
      drawing = false
      return
    }
    if (!drawing) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
    drawing = true
  })
  ctx.stroke()
}

function framesOf(trace: Float32Array | null) {
  if (!trace) return []
  const frames: { detected: number; corrected: number }[] = []
  for (let i = 0; i + 1 < trace.length; i += 2) frames.push({ detected: trace[i] || 0, corrected: trace[i + 1] || 0 })
  return frames
}

function latestPair(trace: Float32Array | null) {
  const frames = framesOf(trace)
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].detected > 0 || frames[i].corrected > 0) return frames[i]
  }
  return null
}

function midiOf(hz: number) {
  return 69 + 12 * Math.log2(hz / 440)
}

function noteLabel(hz: number) {
  if (hz <= 0) return '—'
  const midi = Math.round(midiOf(hz))
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  return `${name}${Math.floor(midi / 12) - 1}`
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function retuneText(value: number) {
  if (value >= 0.85) return 'Fast'
  if (value >= 0.45) return 'Medium'
  return 'Slow'
}

function semitones(value: number) {
  const semis = Math.round(value)
  if (semis > 0) return `+${semis} st`
  return `${semis} st`
}
