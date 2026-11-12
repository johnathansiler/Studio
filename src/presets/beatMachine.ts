import { type PadProgram } from '../model/padMachine'
import { applyKit } from './apply'
import { factoryPresets } from './factory'
import { resolveParams } from './bounds'
import type { CuePreset } from './types'

/** Factory kit presets for the Beat Machine. The kit face stays owned by its builder. */
export function beatMachinePresetList(): CuePreset[] {
  return factoryPresets('pads')
}

export function applyBeatMachinePreset(kit: PadProgram, preset: CuePreset): PadProgram {
  return applyKit(kit, resolveParams('pads', preset.params))
}

