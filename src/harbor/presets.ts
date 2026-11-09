import type { InstrumentPlay } from '../audio/multisample/types'
import type { UserPreset } from '../model/types'
import type { HarborInstrument } from './program'

export interface HarborPreset {
  id: string
  name: string
  source: 'factory' | 'user'
  articulation: string
  play: InstrumentPlay
}

const NATURAL: InstrumentPlay = { tune: 0, attack: 0.008, decay: 0.18, sustain: 0.82, release: 0.4, tone: 16000 }
const SOFT: InstrumentPlay = { tune: 0, attack: 0.12, decay: 0.45, sustain: 0.9, release: 0.9, tone: 9000 }
const SHORT: InstrumentPlay = { tune: 0, attack: 0.002, decay: 0.08, sustain: 0.35, release: 0.06, tone: 14000 }

export function harborPluginId(instrumentId: string) {
  return `harbor:${instrumentId.replace(/^harbor:/, '')}`
}

function presetId(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'
}

/** One factory preset for each articulation, plus a softer and a shorter reading of the main one. */
export function factoryHarborPresets(instrument: Pick<HarborInstrument, 'articulations'>): HarborPreset[] {
  const articulations = instrument.articulations.length ? instrument.articulations : ['Sustain']
  const primary = articulations[0]
  const list: HarborPreset[] = articulations.map((articulation) => ({
    id: presetId(articulation),
    name: articulation,
    source: 'factory',
    articulation,
    play: { ...NATURAL },
  }))
  if (!list.some((item) => item.name.toLowerCase() === 'soft')) {
    list.push({ id: 'soft', name: 'Soft', source: 'factory', articulation: primary, play: { ...SOFT } })
  }
  if (!list.some((item) => item.name.toLowerCase() === 'short')) {
    list.push({ id: 'short', name: 'Short', source: 'factory', articulation: primary, play: { ...SHORT } })
  }
  return list
}

export function presetParams(preset: Pick<HarborPreset, 'articulation' | 'play'>, articulations: string[]) {
  const index = Math.max(0, articulations.indexOf(preset.articulation))
  return {
    artic: index,
    tune: preset.play.tune,
    attack: preset.play.attack,
    decay: preset.play.decay,
    sustain: preset.play.sustain,
    release: preset.play.release,
    tone: preset.play.tone,
  }
}

export function presetFromParams(name: string, params: Record<string, number>, articulations: string[], source: 'factory' | 'user'): HarborPreset {
  const index = Math.max(0, Math.min(articulations.length - 1, Math.round(params.artic || 0)))
  return {
    id: presetId(name),
    name,
    source,
    articulation: articulations[index] || articulations[0] || 'Sustain',
    play: {
      tune: params.tune || 0,
      attack: params.attack ?? NATURAL.attack,
      decay: params.decay ?? NATURAL.decay,
      sustain: params.sustain ?? NATURAL.sustain,
      release: params.release ?? NATURAL.release,
      tone: params.tone || NATURAL.tone,
    },
  }
}

export function userHarborPresets(stored: readonly UserPreset[], instrumentId: string, articulations: string[]): HarborPreset[] {
  const pluginId = harborPluginId(instrumentId)
  return stored
    .filter((item) => item.pluginId === pluginId && item.name.trim())
    .map((item) => presetFromParams(item.name, item.params, articulations, 'user'))
}

export function harborPresetChoices(instrument: Pick<HarborInstrument, 'id' | 'articulations'>, stored: readonly UserPreset[]) {
  const factory = factoryHarborPresets(instrument)
  const users = userHarborPresets(stored, instrument.id, instrument.articulations)
  const seen = new Set(factory.map((item) => item.name.toLowerCase()))
  return factory.concat(users.filter((item) => {
    const key = item.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }))
}
