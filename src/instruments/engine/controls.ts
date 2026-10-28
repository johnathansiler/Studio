import type { MicPosition, SampleControl, SampleInstrumentDef } from './types'

export const SAMPLE_CONTROLS: SampleControl[] = [
  { id: 'level', name: 'Level', description: 'Overall loudness of this instrument.', min: 0, max: 1.5, default: 0.85, unit: '', step: 0.01 },
  { id: 'attack', name: 'Attack', description: 'How quickly a new note fades in.', min: 0, max: 2000, default: 4, unit: 'ms', step: 1 },
  { id: 'decay', name: 'Decay', description: 'Time to fall from the peak to the held level.', min: 0, max: 4000, default: 160, unit: 'ms', step: 1 },
  { id: 'sustain', name: 'Sustain', description: 'Level held while the key stays down.', min: 0, max: 1, default: 0.9, unit: '', step: 0.01 },
  { id: 'release', name: 'Release', description: 'How long the note rings after you let go.', min: 0, max: 8000, default: 280, unit: 'ms', step: 1 },
  { id: 'tune', name: 'Tune', description: 'Pitch offset for every zone, in cents.', min: -100, max: 100, default: 0, unit: 'ct', step: 1 },
  { id: 'velXfade', name: 'Vel fade', description: 'Width of the equal-power blend between soft and loud layers.', min: 0, max: 32, default: 8, unit: '', step: 1 },
  { id: 'rrMode', name: 'Round robin', description: '0 plays round-robins in order. 1 picks one at random.', min: 0, max: 1, default: 0, unit: '', step: 1 },
  { id: 'loopXfade', name: 'Loop fade', description: 'Crossfade at a loop point so the join does not click.', min: 0, max: 1, default: 0.35, unit: '', step: 0.01 },
]

export function micControl(mic: MicPosition): SampleControl {
  return {
    id: `mic:${mic.id}`,
    name: mic.name,
    description: mic.description || `Level of the ${mic.name} microphone.`,
    min: 0,
    max: 1.5,
    default: mic.gain,
    unit: '',
    step: 0.01,
  }
}

/** Built-in controls, one level per microphone, then file controls. A file control with the same id replaces the default. */
export function controlsFor(def: Pick<SampleInstrumentDef, 'controls' | 'mics'>): SampleControl[] {
  const out: SampleControl[] = []
  const push = (control: SampleControl, override: boolean) => {
    const index = out.findIndex((item) => item.id === control.id)
    if (index >= 0) {
      if (override) out[index] = { ...out[index], ...control, description: control.description || out[index].description }
      return
    }
    out.push(control)
  }
  for (const control of SAMPLE_CONTROLS) push(control, false)
  for (const mic of def.mics) push(micControl(mic), false)
  for (const control of def.controls) push(control, true)
  return out
}

export function controlValues(def: Pick<SampleInstrumentDef, 'controls' | 'mics'>, current: Record<string, number> = {}): Record<string, number> {
  const values: Record<string, number> = {}
  for (const control of controlsFor(def)) values[control.id] = current[control.id] ?? control.default
  return values
}
