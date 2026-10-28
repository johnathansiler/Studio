import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CATALOG } from '../../audio/plugins/catalog'
import type { ParamSpec } from '../../audio/plugins/types'
import { Keyboard, Knob, Shell, Toggle } from '../kit/controls'
import {
  EQ_DB_MAX,
  EQ_DB_MIN,
  EQ_HZ_MAX,
  EQ_HZ_MIN,
  dbToY,
  eqGainAt,
  driveShape,
  eqPath,
  freqToX,
  transferPoints,
  xToFreq,
  yToDb,
} from './curves'
import { TOGGLE_IDS, themeFor, type FaceFamily } from './themes'
import '../kit/kit.css'

const W = 640
const H = 220

export function PluginFace({
  pluginId,
  params,
  values,
  vu = -20,
  gr = 0,
  compact = false,
  showParams = true,
  keyboard = false,
  onChange,
  onNote,
  children,
}: {
  pluginId: string
  params: ParamSpec[]
  values: Record<string, number>
  vu?: number
  gr?: number
  spectrum?: Float32Array | null
  compact?: boolean
  showParams?: boolean
  keyboard?: boolean
  onChange: (id: string, value: number) => void
  onNote?: (note: number, down: boolean) => void
  children?: ReactNode
}) {
  const theme = themeFor(pluginId)
  const [open, setOpen] = useState(true)
  const family = theme.family
  return (
    <Shell theme={theme} compact={compact}>
      {family === 'eq' && <EqStage pluginId={pluginId} params={params} values={values} onChange={onChange} />}
      {family === 'dyn' && <DynStage pluginId={pluginId} values={values} vu={vu} gr={gr} />}
      {family === 'space' && <SpaceStage pluginId={pluginId} values={values} />}
      {family === 'color' && <ColorStage pluginId={pluginId} values={values} vu={vu} />}
      {family === 'mod' && <ModStage pluginId={pluginId} values={values} />}
      {family === 'inst' && pluginId !== 'looper' && <InstStage pluginId={pluginId} />}
      {family === 'util' && <UtilStage pluginId={pluginId} values={values} vu={vu} />}
      {keyboard && <Keyboard compact={compact} onDown={(note) => onNote?.(note, true)} onUp={(note) => onNote?.(note, false)} />}
      {children}
      {showParams && (
        <div className={`kit-body${compact && !open ? ' shut' : ''}`}>
          {compact && (
            <button type="button" className="kit-fold" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? 'Hide' : 'Controls'}
            </button>
          )}
          {(!compact || open) && <ParamLayout family={family} pluginId={pluginId} params={params} values={values} onChange={onChange} />}
        </div>
      )}
    </Shell>
  )
}

export function FaceGallery({ compact = false }: { compact?: boolean }) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 720)
  useEffect(() => {
    const apply = () => setNarrow(window.innerWidth <= 720)
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  const phone = compact || narrow
  return (
    <div className="face-gallery">
      {CATALOG.filter((plugin) => plugin.id !== 'tune' && plugin.id !== 'scaler').map((plugin) => {
        const values = Object.fromEntries(plugin.params.map((param) => [param.id, param.default]))
        Object.assign(values, GALLERY_BIAS[plugin.id] ?? {})
        return (
          <div key={plugin.id} id={`face-${plugin.id}`} data-face={plugin.id}>
            <PluginFace
              pluginId={plugin.id}
              params={plugin.params}
              values={values}
              vu={plugin.id === 'meter' ? -3 : -8}
              gr={themeFor(plugin.id).family === 'dyn' ? 6 : 0}
              compact={phone}
              keyboard={plugin.id === 'sampler'}
              onChange={() => undefined}
            />
          </div>
        )
      })}
    </div>
  )
}

const GALLERY_BIAS: Record<string, Record<string, number>> = {
  eq: { hp: 70, lowF: 140, lowG: 3, lowQ: 0.8, midF: 2400, midG: -2.5, midQ: 1.4, highF: 9000, highG: 4, highQ: 0.7, lp: 17000 },
  compressor: { threshold: -22, ratio: 4, attack: 12, release: 140, knee: 8, makeup: 4, mix: 1 },
  reverb: { size: 0.72, damp: 0.35, mix: 0.28 },
  delay: { time: 380, feedback: 0.42, mix: 0.3 },
  tape: { drive: 0.45, wow: 0.2 },
  saturator: { drive: 0.55, mix: 0.7 },
}

function ParamLayout({
  family,
  pluginId,
  params,
  values,
  onChange,
}: {
  family: FaceFamily
  pluginId: string
  params: ParamSpec[]
  values: Record<string, number>
  onChange: (id: string, value: number) => void
}) {
  if (family === 'eq' && bandsOf(params).length) {
    const bands = bandsOf(params)
    const used = new Set(bands.flatMap((band) => [band.freqId, band.gainId, band.qId].filter(Boolean) as string[]))
    const rest = params.filter((param) => !used.has(param.id))
    return (
      <div className="eq-bands">
        {bands.map((band) => (
          <fieldset key={band.id} className="eq-band">
            <legend style={{ color: band.color }}>{band.label}</legend>
            <Row params={pick(params, [band.freqId, band.gainId, band.qId])} values={values} onChange={onChange} />
          </fieldset>
        ))}
        {rest.length > 0 && <Row params={rest} values={values} onChange={onChange} />}
      </div>
    )
  }
  const size = family === 'dyn' || pluginId === 'compressor' ? 'lg' : family === 'mod' ? 'sm' : 'md'
  return <Row params={params.filter((param) => param.id !== 'mask')} values={values} onChange={onChange} size={size} />
}

function Row({
  params,
  values,
  onChange,
  size = 'md',
}: {
  params: ParamSpec[]
  values: Record<string, number>
  onChange: (id: string, value: number) => void
  size?: 'sm' | 'md' | 'lg'
}) {
  const toggles = params.filter((param) => TOGGLE_IDS.has(param.id) && param.max <= 1)
  const knobs = params.filter((param) => !toggles.includes(param))
  return (
    <div className="kit-stack">
      {toggles.length > 0 && (
        <div className="kit-toggles">
          {toggles.map((param) => (
            <Toggle
              key={param.id}
              label={param.name}
              on={(values[param.id] ?? param.default) >= 0.5}
              onClick={() => onChange(param.id, (values[param.id] ?? param.default) >= 0.5 ? 0 : 1)}
            />
          ))}
        </div>
      )}
      <div className={`kit-row size-${size}`}>
        {knobs.map((param) => {
          const value = values[param.id] ?? param.default
          const shared = {
            label: param.name,
            min: param.min,
            max: param.max,
            value,
            unit: param.unit,
            fallback: param.default,
            onChange: (next: number) => onChange(param.id, next),
          }
          return <Knob key={param.id} {...shared} />
        })}
      </div>
    </div>
  )
}

function EqStage({
  params,
  values,
  onChange,
}: {
  pluginId: string
  params: ParamSpec[]
  values: Record<string, number>
  onChange: (id: string, value: number) => void
}) {
  const bands = bandsOf(params)
  const drag = useRef<Band | null>(null)
  const path = eqPath(values, W, H)
  const move = (clientX: number, clientY: number, box: DOMRect) => {
    const band = drag.current
    if (!band) return
    const freq = clamp(xToFreq(clientX - box.left, box.width), specMin(params, band.freqId, EQ_HZ_MIN), specMax(params, band.freqId, EQ_HZ_MAX))
    const db = clamp(yToDb(((clientY - box.top) / box.height) * H, H), specMin(params, band.gainId, EQ_DB_MIN), specMax(params, band.gainId, EQ_DB_MAX))
    onChange(band.freqId, freq)
    onChange(band.gainId, db)
  }
  return (
    <svg
      className="kit-eq"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Frequency response"
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        const x = ((event.clientX - box.left) / box.width) * W
        drag.current = nearest(bands, values, x)
        event.currentTarget.setPointerCapture(event.pointerId)
        move(event.clientX, event.clientY, box)
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        move(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
    >
      {[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((freq) => (
        <g key={freq}>
          <line x1={freqToX(freq, W)} x2={freqToX(freq, W)} y1={0} y2={H} className="grid" />
          <text x={freqToX(freq, W) + 4} y={H - 6} className="tick">{freq >= 1000 ? `${freq / 1000}k` : freq}</text>
        </g>
      ))}
      {[-12, -6, 0, 6, 12].map((db) => (
        <g key={db}>
          <line x1={0} x2={W} y1={dbToY(db, H)} y2={dbToY(db, H)} className={db === 0 ? 'zero' : 'grid'} />
          <text x={6} y={dbToY(db, H) - 4} className="tick">{db}</text>
        </g>
      ))}
      <path d={path} className="curve" />
      {bands.map((band) => {
        const freq = values[band.freqId] ?? 1000
        const x = freqToX(freq, W)
        const y = dbToY(eqGainAt(freq, values), H)
        return <circle key={band.id} cx={x} cy={y} r={9} fill={band.color} className="node" />
      })}
    </svg>
  )
}

function DynStage({ pluginId, values, vu, gr }: { pluginId: string; values: Record<string, number>; vu: number; gr: number }) {
  const raw = values.ratio ?? 2
  const ratio = pluginId === 'fet' ? [4, 8, 12, 20, 20][Math.round(raw)] ?? 4 : pluginId === 'bus' ? [2, 4, 10][Math.round(raw)] ?? 2 : raw || 2
  const threshold = values.threshold ?? values.ceiling ?? -12
  const knee = values.knee ?? 0
  const points = transferPoints(threshold, ratio, knee, 48)
  const d = points.map((out, index) => {
    const input = -60 + (60 * index) / (points.length - 1)
    const x = ((input + 60) / 60) * W
    const y = ((0 - Math.max(-60, Math.min(0, out))) / 60) * H
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  const mark = ((Math.max(-60, Math.min(0, threshold)) + 60) / 60) * W
  return (
    <div className="dyn-stage">
      <NeedleMeter label="GR" value={Math.max(0, Math.min(20, gr))} min={0} max={20} />
      <NeedleMeter label="VU" value={vu} min={-20} max={3} />
      <svg className="kit-eq" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Transfer curve">
        <line x1={0} y1={H} x2={W} y2={0} className="grid" />
        {[-48, -36, -24, -12, 0].map((db) => (
          <line key={db} x1={((db + 60) / 60) * W} x2={((db + 60) / 60) * W} y1={0} y2={H} className="grid" />
        ))}
        <path d={d} className="curve" />
        <line x1={mark} x2={mark} y1={0} y2={H} className="zero" />
        <text x={Math.min(W - 70, mark + 6)} y={18} className="tick">Thresh</text>
      </svg>
    </div>
  )
}

function SpaceStage({ pluginId, values }: { pluginId: string; values: Record<string, number> }) {
  const room = pluginId === 'reverb' || pluginId === 'plate' || pluginId === 'hall' || pluginId === 'conv'
  return (
    <div className={`space-stage ${pluginId}`} aria-label={room ? 'Decay' : 'Echo taps'}>
      {room ? <RoomGraphic pluginId={pluginId} values={values} /> : <EchoGraphic pluginId={pluginId} values={values} />}
    </div>
  )
}

function RoomGraphic({ pluginId, values }: { pluginId: string; values: Record<string, number> }) {
  const size = values.size ?? values.decay ?? 0.6
  const damp = values.damp ?? values.mix ?? 0.4
  const rings = pluginId === 'plate' ? 4 : pluginId === 'hall' ? 7 : 5
  return (
    <svg viewBox="0 0 640 140" role="img" aria-label={pluginId === 'plate' ? 'Plate' : 'Room'}>
      <rect x="18" y="16" width="604" height="108" rx={pluginId === 'plate' ? 6 : 54} className="room" />
      {Array.from({ length: rings }, (_, index) => {
        const t = (index + 1) / rings
        const rx = 40 + size * 250 * t
        const ry = 12 + (1 - damp) * 40 * t
        return <ellipse key={index} cx="320" cy="74" rx={rx} ry={ry} className="ring" opacity={1 - t * 0.72} />
      })}
    </svg>
  )
}

function EchoGraphic({ pluginId, values }: { pluginId: string; values: Record<string, number> }) {
  const taps = echoTaps(values.time ?? values.division ?? 0.4, values.feedback ?? 0.35)
  const marks = taps.map((value, index) => ({ value, index })).filter((tap) => tap.value > 0.2)
  return (
    <svg viewBox="0 0 640 140" role="img" aria-label={pluginId === 'bbd' ? 'Bucket delay' : 'Echo'}>
      <line x1="24" y1="96" x2="616" y2="96" className="grid" />
      {marks.map((tap) => {
        const x = 36 + (tap.index / Math.max(1, taps.length - 1)) * 568
        const h = 16 + tap.value * 70
        return (
          <g key={tap.index}>
            <line x1={x} y1={96} x2={x} y2={96 - h} className="echo" />
            <circle cx={x} cy={96 - h} r={pluginId === 'digital' ? 3 : 5} className="echo-dot" />
          </g>
        )
      })}
    </svg>
  )
}

function ColorStage({ pluginId, values, vu }: { pluginId: string; values: Record<string, number>; vu: number }) {
  const reels = pluginId === 'tape' || pluginId === 'mtape'
  const drive = values.drive ?? values.ceiling ?? 0.3
  return (
    <div className={`color-stage kind-${pluginId}`}>
      {reels ? (
        <div className="reels" aria-label="Tape reels">
          <i style={{ animationDuration: `${Math.max(0.6, 1.8 - drive)}s` }} />
          <i style={{ animationDuration: `${Math.max(0.6, 1.8 - drive)}s` }} />
        </div>
      ) : pluginId === 'clip' ? (
        <div className="clip-lamps" aria-label="Clip">
          {Array.from({ length: 10 }, (_, index) => (
            <i key={index} className={index / 10 < drive ? 'hot' : ''} />
          ))}
        </div>
      ) : (
        <svg className="kit-eq short" viewBox={`0 0 ${W} 120`} aria-label="Drive">
          {pluginId === 'saturator' && <circle cx="70" cy="60" r="28" className="tube" />}
          <path className="curve" d={driveShape(drive, 48).map((y, index) => {
            const x = (index / 47) * W
            const py = 60 - y * 52
            return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${py.toFixed(1)}`
          }).join(' ')} />
        </svg>
      )}
      <NeedleMeter label="VU" value={vu} min={-20} max={3} />
    </div>
  )
}

function ModStage({ pluginId, values }: { pluginId: string; values: Record<string, number> }) {
  const depth = values.depth ?? values.mix ?? 0.4
  if (pluginId === 'rotor') {
    return (
      <div className="mod-stage rotor" aria-label="Rotor">
        <i className="horn" style={{ animationDuration: `${1.8 - depth}s` }} />
        <i className="horn bass" style={{ animationDuration: `${2.6 - depth}s` }} />
      </div>
    )
  }
  if (pluginId === 'phase') {
    return (
      <svg className="kit-eq short" viewBox="0 0 640 120" aria-label="Phase">
        {Array.from({ length: 6 }, (_, index) => {
          const x = 80 + index * 90 + depth * 20
          return <path key={index} className="curve" d={`M${x - 30} 20 Q ${x} 100 ${x + 30} 20`} opacity={0.35 + index * 0.1} />
        })}
      </svg>
    )
  }
  const voices = pluginId === 'ensemble' ? 6 : pluginId === 'doubler' ? 2 : 3
  return (
    <svg className="kit-eq short" viewBox="0 0 640 120" aria-label="Modulation">
      {Array.from({ length: voices }, (_, voice) => {
        const amp = 12 + depth * 28
        const d = Array.from({ length: 32 }, (_, index) => {
          const x = (index / 31) * 640
          const y = 60 + Math.sin(index / 3 + voice) * amp
          return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
        }).join(' ')
        return <path key={voice} className="curve" d={d} opacity={0.45 + voice * 0.15} />
      })}
    </svg>
  )
}

function InstStage({ pluginId }: { pluginId: string }) {
  if (pluginId === 'sampler' || pluginId === 'looper') return null
  return null
}

function UtilStage({ pluginId, values, vu }: { pluginId: string; values: Record<string, number>; vu: number }) {
  if (pluginId === 'meter') {
    return (
      <div className="dyn-stage">
        <NeedleMeter label="L" value={vu} min={-20} max={3} />
        <NeedleMeter label="R" value={vu - 1} min={-20} max={3} />
      </div>
    )
  }
  if (pluginId === 'image' || pluginId === 'msbox') {
    const width = pluginId === 'image' ? values.width ?? 1 : (values.side ?? 0) / 12 + 1
    return (
      <div className="image-stage" aria-label="Stereo width">
        <i style={{ width: `${Math.max(8, Math.min(100, width * 50))}%` }} />
      </div>
    )
  }
  return <NeedleMeter label="Out" value={vu} min={-20} max={3} />
}

function NeedleMeter({ label, value, min, max }: { label: string; value: number; min: number; max: number }) {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min || 1)))
  const angle = -48 + t * 96
  return (
    <div className="needle-meter" aria-label={`${label} ${value.toFixed(1)}`}>
      <svg viewBox="0 0 120 78">
        <path d="M14 70 A46 46 0 0 1 106 70" className="arc" />
        <line x1="60" y1="70" x2="60" y2="28" transform={`rotate(${angle} 60 70)`} className="arm" />
        <circle cx="60" cy="70" r="4" className="hub" />
      </svg>
      <strong>{label}</strong>
      <em>{value.toFixed(1)}</em>
    </div>
  )
}

interface Band {
  id: string
  label: string
  freqId: string
  gainId: string
  qId?: string
  color: string
}

function bandsOf(params: ParamSpec[]): Band[] {
  const ids = new Set(params.map((param) => param.id))
  const has = (id: string) => ids.has(id)
  const bands: Band[] = []
  if (has('lowF') && has('lowG')) bands.push({ id: 'low', label: 'Low', freqId: 'lowF', gainId: 'lowG', qId: has('lowQ') ? 'lowQ' : undefined, color: '#e0b15a' })
  if (has('midF') && has('midG')) bands.push({ id: 'mid', label: 'Mid', freqId: 'midF', gainId: 'midG', qId: has('midQ') ? 'midQ' : undefined, color: '#3ec6ff' })
  if (has('highF') && has('highG')) bands.push({ id: 'high', label: 'High', freqId: 'highF', gainId: 'highG', qId: has('highQ') ? 'highQ' : undefined, color: '#f09a6a' })
  if (has('f0') && has('g0')) bands.push({ id: 'b0', label: 'Low', freqId: 'f0', gainId: 'g0', qId: has('q0') ? 'q0' : undefined, color: '#e0b15a' })
  if (has('f1') && has('g1')) bands.push({ id: 'b1', label: 'Mid', freqId: 'f1', gainId: 'g1', qId: has('q1') ? 'q1' : undefined, color: '#3ec6ff' })
  if (has('f2') && has('g2')) bands.push({ id: 'b2', label: 'High', freqId: 'f2', gainId: 'g2', qId: has('q2') ? 'q2' : undefined, color: '#f09a6a' })
  if (!bands.length && has('freq') && has('gain')) bands.push({ id: 'band', label: 'Band', freqId: 'freq', gainId: 'gain', qId: has('q') ? 'q' : undefined, color: '#c084fc' })
  return bands
}

function pick(params: ParamSpec[], ids: (string | undefined)[]) {
  return ids.filter((id): id is string => !!id).map((id) => params.find((param) => param.id === id)).filter((param): param is ParamSpec => !!param)
}

function nearest(bands: Band[], values: Record<string, number>, x: number) {
  let best = bands[0]
  let dist = Infinity
  for (const band of bands) {
    const delta = Math.abs(freqToX(values[band.freqId] ?? 1000, W) - x)
    if (delta < dist) {
      dist = delta
      best = band
    }
  }
  return best
}

function specMin(params: ParamSpec[], id: string, fallback: number) {
  return params.find((param) => param.id === id)?.min ?? fallback
}

function specMax(params: ParamSpec[], id: string, fallback: number) {
  return params.find((param) => param.id === id)?.max ?? fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function echoTaps(time: number, feedback: number) {
  const gap = 2 + Math.round((Math.max(1, time) / 1000) * 8)
  return Array.from({ length: 36 }, (_, index) => (index % gap === 0 ? Math.pow(Math.max(0.05, Math.min(0.92, feedback)), index / gap) : 0.04))
}
