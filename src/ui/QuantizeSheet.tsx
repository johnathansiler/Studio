import { DIVISIONS, MPC_SWING, mpcGroove, type Feel, type QuantizeScope, type RecordQuantize, type SwingUnit, type VelocityMode } from '../model/quantize'
import { selectQuantize } from '../state/select'
import type { ProjectStore } from '../state/store'

const FEELS: Feel[] = ['straight', 'triplet', 'dotted', 'quintuplet', 'septuplet', 'custom']
const FEEL_LABEL: Record<Feel, string> = {
  straight: 'Straight',
  triplet: 'Triplet',
  dotted: 'Dotted',
  quintuplet: '5',
  septuplet: '7',
  custom: 'Tuplet',
}

export function QuantizeSheet({ store }: { store: ProjectStore }) {
  if (!store.quantizeOpen) return null
  const quantize = selectQuantize(store)
  const settings = quantize.draft
  const presets = quantize.presets
  return (
    <div className="q-sheet">
      <div className="row">
        <select aria-label="Grid" value={settings.division} onChange={(event) => store.setQuantizeDraft({ division: Number(event.target.value) as (typeof DIVISIONS)[number] })}>
          {DIVISIONS.map((division) => (
            <option key={division} value={division}>{`1/${division}`}</option>
          ))}
        </select>
        <select aria-label="Feel" value={settings.feel} onChange={(event) => store.setQuantizeDraft({ feel: event.target.value as Feel })}>
          {FEELS.map((feel) => (
            <option key={feel} value={feel}>{FEEL_LABEL[feel]}</option>
          ))}
        </select>
        <input aria-label="Strength" type="range" min={0} max={1} step={0.01} value={settings.strength} onChange={(event) => store.setQuantizeDraft({ strength: Number(event.target.value) })} />
        <select aria-label="Scope" value={settings.scope} onChange={(event) => store.setQuantizeDraft({ scope: event.target.value as QuantizeScope })}>
          <option value="selection">Sel</option>
          <option value="clip">Clip</option>
          <option value="track">Track</option>
          <option value="pattern">Pat</option>
        </select>
        <button type="button" onClick={() => store.commitQuantize()}>Apply</button>
        <button type="button" onClick={() => store.closeQuantize()}>Close</button>
      </div>
      <details>
        <summary>More</summary>
        <div className="row">
          {settings.feel === 'custom' && (
            <>
              <input aria-label="Tuplet notes" type="number" min={2} max={16} value={settings.tupletN} onChange={(event) => store.setQuantizeDraft({ tupletN: Number(event.target.value) })} />
              <input aria-label="Tuplet space" type="number" min={1} max={16} value={settings.tupletM} onChange={(event) => store.setQuantizeDraft({ tupletM: Number(event.target.value) })} />
            </>
          )}
          <input aria-label="Swing" type="range" min={0} max={1} step={0.01} value={settings.swing} onChange={(event) => store.setQuantizeDraft({ swing: Number(event.target.value), groove: null })} />
          <select aria-label="Swing unit" value={settings.swingUnit} onChange={(event) => store.setQuantizeDraft({ swingUnit: event.target.value as SwingUnit })}>
            <option value="8">8</option>
            <option value="16">16</option>
          </select>
          <select
            aria-label="Groove"
            value={MPC_SWING.find((percent) => settings.groove?.name === `MPC ${percent}`)?.toString() ?? (settings.groove ? 'clip' : '')}
            onChange={(event) => {
              if (event.target.value === 'clip') return
              const percent = Number(event.target.value)
              store.setQuantizeDraft({ groove: percent ? mpcGroove(percent) : null, swing: percent ? 0 : settings.swing })
            }}
          >
            <option value="">Groove</option>
            {MPC_SWING.map((percent) => (
              <option key={percent} value={percent}>{`MPC ${percent}`}</option>
            ))}
            {settings.groove && !settings.groove.name.startsWith('MPC') && <option value="clip">{settings.groove.name}</option>}
          </select>
          <button type="button" onClick={() => store.extractQuantizeGroove()}>Extract</button>
          <input aria-label="Window" type="number" min={0} max={100} value={settings.window} onChange={(event) => store.setQuantizeDraft({ window: Number(event.target.value) })} />
          <input aria-label="Threshold" type="number" min={0} max={1} step={0.01} value={settings.threshold} onChange={(event) => store.setQuantizeDraft({ threshold: Number(event.target.value) })} />
        </div>
        <div className="row">
          <button type="button" className={settings.starts ? 'on' : ''} onClick={() => store.setQuantizeDraft({ starts: !settings.starts })}>Start</button>
          <button type="button" className={settings.ends ? 'on' : ''} onClick={() => store.setQuantizeDraft({ ends: !settings.ends, keepLength: false })}>End</button>
          <button type="button" className={settings.keepLength ? 'on' : ''} onClick={() => store.setQuantizeDraft({ keepLength: !settings.keepLength })}>Len</button>
          <button type="button" className={settings.lengthQuantize ? 'on' : ''} onClick={() => store.setQuantizeDraft({ lengthQuantize: !settings.lengthQuantize })}>Dur</button>
          <button type="button" className={settings.fixOverlaps ? 'on' : ''} onClick={() => store.setQuantizeDraft({ fixOverlaps: !settings.fixOverlaps })}>Fix</button>
          <button type="button" className={settings.legato ? 'on' : ''} onClick={() => store.setQuantizeDraft({ legato: !settings.legato })}>Legato</button>
          <button type="button" className={settings.scaleSnap ? 'on' : ''} onClick={() => store.setQuantizeDraft({ scaleSnap: !settings.scaleSnap })}>Scale</button>
        </div>
        <div className="row">
          <input aria-label="Humanize ms" type="number" min={0} max={80} value={settings.humanizeMs} onChange={(event) => store.setQuantizeDraft({ humanizeMs: Number(event.target.value) })} />
          <input aria-label="Humanize velocity" type="number" min={0} max={100} value={settings.humanizeVel} onChange={(event) => store.setQuantizeDraft({ humanizeVel: Number(event.target.value) })} />
          <input aria-label="Seed" type="number" value={settings.seed ?? ''} onChange={(event) => store.setQuantizeDraft({ seed: event.target.value === '' ? null : Number(event.target.value) })} />
          <select aria-label="Velocity" value={settings.velocity} onChange={(event) => store.setQuantizeDraft({ velocity: event.target.value as VelocityMode })}>
            <option value="off">Vel</option>
            <option value="fixed">Fixed</option>
            <option value="compress">Compress</option>
          </select>
          {settings.velocity === 'compress' && (
            <input aria-label="Compress" type="range" min={0} max={1} step={0.01} value={settings.velocityCompress} onChange={(event) => store.setQuantizeDraft({ velocityCompress: Number(event.target.value) })} />
          )}
          <select aria-label="Record quantize" value={settings.record} onChange={(event) => store.setQuantizeDraft({ record: event.target.value as RecordQuantize })}>
            <option value="off">Rec off</option>
            <option value="live">Live</option>
            <option value="after">After</option>
          </select>
          <select aria-label="Preset" value="" onChange={(event) => store.loadQuantizePreset(event.target.value)}>
            <option value="">Preset</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => store.saveQuantizePreset(settings.groove?.name || `1/${settings.division}`)}>Save</button>
        </div>
      </details>
    </div>
  )
}
