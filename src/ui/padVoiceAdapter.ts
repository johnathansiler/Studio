/**
 * Stand-in for the Rust voice until pad.setRegion and pad.setVintage land.
 * Do not grow this into a sampler. Playback already windows a pad through
 * PadVoice.region and preparePadPcm. Vintage numbers are stored here so the
 * core call can take the scaled values, or a macro plus this depth table.
 */

import type { PadRegion, PadVoice } from '../model/padMachine'
import { padRegion } from '../model/padMachine'
import type { ScaledVintage, VintageState, VintageTable } from '../model/padChop'
import { scaleVintage, vintageTable } from '../model/padChop'

export interface RegionCall {
  sampleId: string
  start: number
  end: number
}

export function setPadRegion(
  pad: PadVoice,
  sampleId: string,
  start: number,
  end: number,
  extra?: { reverse?: boolean; gate?: 'shot' | 'hold' },
): PadVoice {
  const region: PadRegion = {
    ...padRegion(pad),
    start: clamp01(start),
    end: Math.max(clamp01(start), clamp01(end)),
    reverse: extra?.reverse ?? pad.region?.reverse ?? false,
  }
  return {
    ...pad,
    gate: extra?.gate ?? pad.gate ?? 'shot',
    sampleName: pad.sampleName,
    layers: [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: sampleId }],
    region,
  }
}

/**
 * The shape pad.setVintage can take: each depth after the macro, or the macro
 * plus the depth table that those depths were scaled from.
 */
export interface VintageCall extends ScaledVintage {
  macro: number
  table: VintageTable
}

/** pad.setVintage({ ... }) after the macro has scaled each depth. */
export function setPadVintage(state: VintageState | undefined): VintageCall {
  const table = state?.table ?? vintageTable()
  const macro = state ? clamp01(state.macro) : 0
  return { ...scaleVintage(macro, table), macro, table }
}

export function regionCall(pad: PadVoice, sampleId: string): RegionCall {
  const region = padRegion(pad)
  return { sampleId, start: region.start, end: region.end }
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
