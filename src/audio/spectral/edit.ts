import type { AudioClip } from '../../model/types'
import type { SpectralAction, SpectralRegion, SpectralRepair } from './types'

export function spectralKey(repair: SpectralRepair) {
  return JSON.stringify([
    repair.sourceBufferId,
    repair.origin,
    repair.span,
    repair.noiseRate ?? 0,
    repair.noiseBands ?? [],
    repair.ops.map((op) => [
      op.id,
      op.action,
      op.amount,
      op.humHz ?? 0,
      op.region.tool,
      op.region.partials ?? 0,
      op.region.width ?? 0,
      op.region.points.map((point) => [point.t, point.hz]),
    ]),
  ])
}

export function ensureRepair(clip: AudioClip): SpectralRepair {
  if (clip.spectral?.sourceBufferId) return clip.spectral
  clip.spectral = {
    sourceBufferId: clip.bufferId,
    origin: clip.offsetSamples,
    span: Math.max(1, clip.durationSamples),
    enabled: true,
    ops: [],
  }
  return clip.spectral
}

/** Map a 0–1 position in the clip the user is looking at onto the repaired slice. */
export function viewToSlice(clip: AudioClip, t: number) {
  const repair = clip.spectral
  const origin = repair?.origin ?? clip.offsetSamples
  const span = repair?.span || clip.durationSamples || 1
  const sample = clip.offsetSamples + t * clip.durationSamples
  return (sample - origin) / span
}

export function sliceRegion(clip: AudioClip, region: SpectralRegion): SpectralRegion {
  return {
    ...region,
    points: region.points.map((point) => ({ t: viewToSlice(clip, point.t), hz: point.hz })),
  }
}

export function pushOp(clip: AudioClip, action: SpectralAction, region: SpectralRegion, amount: number, humHz?: number, id = '') {
  const repair = ensureRepair(clip)
  repair.enabled = true
  repair.ops = [
    ...repair.ops,
    {
      id,
      action,
      amount: clamp(amount, 0, 1),
      region: sliceRegion(clip, region),
      humHz,
    },
  ]
  repair.renderedKey = undefined
  return repair
}

export function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value))
}
