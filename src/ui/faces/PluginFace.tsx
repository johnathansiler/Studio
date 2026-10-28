import { useState, type ReactNode } from 'react'
import { CATALOG } from '../../audio/plugins/catalog'
import type { ParamSpec } from '../../audio/plugins/types'
import { Fader, Knob, Keyboard, Meter, Shell, Toggle } from '../kit/controls'
import { decaySteps, driveShape, eqPoints, transferPoints } from './curves'
import { TOGGLE_IDS, themeFor, type FaceFamily } from './themes'
import '../kit/kit.css'

export function PluginFace({
  pluginId,
  params,
  values,
  vu = -20,
  gr = 0,
  spectrum,
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
  const toggles = params.filter((param) => TOGGLE_IDS.has(param.id) && param.max - param.min <= 1)
  const continuous = params.filter((param) => !toggles.includes(param) && param.id !== 'mask')
  const useFader = theme.layout !== 'knobs'
  return (
    <Shell theme={theme} compact={compact}>
      <div className="kit-meters">
        <Meter label="In" value={vu + 20} max={24} />
        <Meter label="GR" value={gr} max={20} />
      </div>
      <Display family={theme.family} pluginId={pluginId} values={values} spectrum={spectrum} />
      {keyboard && <Keyboard compact={compact} onDown={(note) => onNote?.(note, true)} onUp={(note) => onNote?.(note, false)} />}
      {children}
      {showParams && (
        <div className={`kit-body${compact && !open ? ' shut' : ''}`}>
          {compact && (
            <button type="button" className="kit-fold" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? 'Hide' : 'Controls'}
            </button>
          )}
          {(!compact || open) && (
            <>
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
              <div className={`kit-controls ${theme.layout}`}>
                {continuous.map((param) => {
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
                  return useFader ? <Fader key={param.id} {...shared} /> : <Knob key={param.id} {...shared} />
                })}
              </div>
            </>
          )}
        </div>
      )}
    </Shell>
  )
}

export function FaceGallery() {
  return (
    <div className="face-gallery" style={{ display: 'grid', gap: 16, padding: 16, background: '#0c110f' }}>
      {CATALOG.filter((plugin) => plugin.id !== 'tune').map((plugin) => (
        <div key={plugin.id} id={`face-${plugin.id}`} data-face={plugin.id}>
          <PluginFace
            pluginId={plugin.id}
            params={plugin.params}
            values={Object.fromEntries(plugin.params.map((param) => [param.id, param.default]))}
            vu={-6}
            gr={plugin.id === 'compressor' ? 4 : 0}
            keyboard={plugin.id === 'sampler' || plugin.id === 'amp'}
            onChange={() => undefined}
          />
        </div>
      ))}
    </div>
  )
}

function Display({ family, pluginId, values, spectrum }: { family: FaceFamily; pluginId: string; values: Record<string, number>; spectrum?: Float32Array | null }) {
  if (family === 'eq') return <Curve points={eqPoints(values)} spectrum={spectrum} />
  if (family === 'dyn') {
    const raw = values.ratio ?? 2
    const ratio = pluginId === 'fet' ? [4, 8, 12, 20, 20][Math.round(raw)] ?? 4 : pluginId === 'bus' ? [2, 4, 10][Math.round(raw)] ?? 2 : raw
    return <Curve points={transferPoints(values.threshold ?? -18, ratio || 2, values.knee ?? 0)} />
  }
  if (family === 'space') return <Bars values={decaySteps(values.size ?? values.time ?? 0.4, values.feedback ?? values.decay ?? values.mix ?? 0.3)} />
  if (family === 'color') return <Curve points={driveShape(values.drive ?? 0.3)} />
  if (family === 'mod') return <Bars values={lfo(values.rate ?? values.speed ?? 0.4, values.depth ?? values.mix ?? 0.5)} />
  return <Bars values={spectrum ? Array.from(spectrum).slice(0, 24) : [0.2, 0.45, 0.7, 0.4, 0.25]} />
}

function lfo(rate: number, depth: number) {
  return Array.from({ length: 24 }, (_, index) => 0.5 + Math.sin(index * 0.45 * (0.4 + rate)) * 0.45 * Math.max(0.15, depth))
}

function Curve({ points, spectrum }: { points: number[]; spectrum?: Float32Array | null }) {
  const min = Math.min(...points, -18)
  const max = Math.max(...points, 12)
  const span = max - min || 1
  const d = points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 300
    const y = 70 - ((point - min) / span) * 60
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg className="kit-display" viewBox="0 0 300 80" role="img" aria-label="Response">
      {spectrum && Array.from(spectrum).slice(0, 32).map((mag, index) => (
        <rect key={index} x={index * (300 / 32)} y={80 - Math.min(1, mag) * 70} width={300 / 32 - 1} height={Math.min(1, mag) * 70} className="spec" />
      ))}
      <path d={d} />
    </svg>
  )
}

function Bars({ values }: { values: number[] }) {
  const peak = Math.max(...values.map((value) => Math.abs(value)), 0.001)
  return (
    <div className="kit-bars" aria-hidden="true">
      {values.map((value, index) => (
        <i key={index} style={{ height: `${Math.max(4, (Math.abs(value) / peak) * 100)}%` }} />
      ))}
    </div>
  )
}
