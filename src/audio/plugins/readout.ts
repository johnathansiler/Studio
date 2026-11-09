/** What a knob prints. Stepped indexes show the value the DSP actually uses. */

const HZ = (values: readonly number[]) => values.map((hz) => (hz >= 1000 ? `${trim(hz / 1000)} kHz` : hz === 0 ? 'Off' : `${hz} Hz`))

function trim(value: number) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function pick(value: number, labels: readonly string[]) {
  const index = Math.max(0, Math.min(labels.length - 1, Math.round(value)))
  return labels[index]
}

function percent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function signedDb(value: number, span: number) {
  const db = (value - 0.5) * span
  const text = Math.abs(db) < 0.05 ? '0' : trim(db)
  return `${db > 0.05 ? '+' : ''}${text} dB`
}

const STEPS: Record<string, readonly string[]> = {
  'eq:pLow': HZ([20, 30, 60, 100]),
  'eq:pHigh': HZ([3000, 4000, 5000, 8000, 10000, 12000, 16000]),
  'eq:pCutF': HZ([5000, 10000, 20000]),
  'eq:preHp': HZ([0, 50, 80, 160, 300]),
  'eq:preLow': HZ([35, 60, 110, 220]),
  'eq:preMid': HZ([360, 700, 1600, 3200, 4800, 7200]),
  'eq:preHigh': ['10 kHz', '12 kHz'],
  'eq:lfF': HZ([60, 110, 220, 360]),
  'eq:lmfF': HZ([200, 400, 800, 1500]),
  'eq:hmfF': HZ([800, 1500, 3000, 6000]),
  'eq:hfF': HZ([6000, 8000, 12000, 16000]),
  'eq:tiltF': HZ([50, 80, 150, 300, 500, 800, 1500, 2500, 5000, 8000, 12000]),
  'compressor:fetRatio': ['4:1', '8:1', '12:1', '20:1', 'All'],
  'compressor:busRatio': ['2:1', '4:1', '10:1'],
  'compressor:busAtk': ['0.1 ms', '0.3 ms', '1 ms', '3 ms', '10 ms', '30 ms'],
  'compressor:busRel': ['100 ms', '300 ms', '600 ms', '1.2 s', 'Auto'],
  'compressor:variTime': ['0.2 / 300 ms', '0.2 / 800 ms', '0.4 / 2 s', '0.8 / 5 s', '0.2 / 2 s', '0.4 / 5 s'],
  'compressor:releaseMode': ['Fast', 'Use release', 'Slow'],
  'saturator:speed': ['7.5 ips', '15 ips', '30 ips'],
  'reverb:mode': ['Room', 'Hall', 'Chamber'],
  'reverb:ir': ['Room', 'Plate'],
  'mod:mode': ['Ensemble', 'Wide'],
  'limiter:releaseMode': ['Fast', 'Use release', 'Slow'],
  'limiter:shape': ['Flat', 'Triangular', 'Shaped'],
}

const PERCENT = new Set(['mix', 'harmonyMix', 'optoPeak', 'pWidth'])

const LABELS: Record<string, string> = {
  'eq:phase': 'Linear phase',
  'eq:pLow': 'Low freq',
  'eq:pBoost': 'Low boost',
  'eq:pAtten': 'Low cut',
  'eq:pHigh': 'High freq',
  'eq:pWidth': 'Bandwidth',
  'eq:pCut': 'High cut',
  'eq:preLow': 'Low freq',
  'eq:preMid': 'Mid freq',
  'eq:preHigh': 'High freq',
  'eq:curve': 'Narrow',
  'eq:lfF': 'LF freq',
  'eq:lmfF': 'LMF freq',
  'eq:hmfF': 'HMF freq',
  'eq:hfF': 'HF freq',
  'compressor:releaseMode': 'Rel mode',
  'compressor:optoPeak': 'Peak reduction',
  'saturator:color': 'Tube',
  'saturator:clipMode': 'Hard',
  'mod:speed': 'Fast',
  'limiter:releaseMode': 'Rel mode',
}

/** Visible name. Stored ids stay put so presets and the Rust layout still match. */
export function controlLabel(pluginId: string, id: string, name: string) {
  return LABELS[`${pluginId}:${id}`] ?? name
}

export function controlChoices(pluginId: string, id: string): readonly string[] | null {
  return STEPS[`${pluginId}:${id}`] ?? null
}

/** Printed value for a plugin control. Falls back to the raw number plus its unit. */
export function controlText(pluginId: string, id: string, value: number, unit = '') {
  const steps = controlChoices(pluginId, id)
  if (steps) return pick(value, steps)
  if ((pluginId === 'saturator' || pluginId === 'amp') && id === 'bass') return signedDb(value, 24)
  if ((pluginId === 'saturator' || pluginId === 'amp') && id === 'mid') return signedDb(value, 20)
  if ((pluginId === 'saturator' || pluginId === 'amp') && id === 'treble') return signedDb(value, 18)
  if ((pluginId === 'saturator' || pluginId === 'amp') && id === 'presence') return signedDb(value, 12)
  if (id === 'pBoost' || id === 'pAtten' || id === 'pCut') return `${trim(Math.max(0, Math.min(1, value)) * 12)} dB`
  if (id === 'pAir') return `${trim(Math.max(0, Math.min(1, value)) * 14)} dB`
  if (PERCENT.has(id)) return percent(value)
  const shown = Math.abs(value) >= 100 ? Math.round(value).toString() : (Math.round(value * 100) / 100).toString()
  return unit ? `${shown} ${unit}` : shown
}
