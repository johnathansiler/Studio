import type { RoundRobinMode, SampleTrigger, SampleZone, ZonePick } from './types'

export interface SelectState {
  articulation: string
  rrMode: RoundRobinMode
  /** Next sequential step, and the last random step, keyed by round-robin group. */
  rr: Map<string, number>
  velFade: number
  /** Microphone id to linear gain. Missing mics stay open. */
  mics: Record<string, number>
  /** Notes already held, before this one. */
  held: number
  random: () => number
}

export function rrGroupKey(zone: SampleZone) {
  if (zone.seqLength <= 1) return ''
  return [zone.articulation, zone.mic, zone.loKey, zone.hiKey, zone.loVel, zone.hiVel, zone.trigger, zone.seqLength].join('|')
}

/** Equal-power fade inside a velocity window. The outer edge of a layer does not fade unless a width is set. */
export function velocityLayerGain(vel: number, lo: number, hi: number, fadeIn: number, fadeOut: number) {
  if (vel < lo || vel > hi) return 0
  let gain = 1
  const inn = Math.max(0, fadeIn)
  const out = Math.max(0, fadeOut)
  if (inn > 0 && vel < lo + inn) gain *= Math.sin(((vel - lo) / inn) * Math.PI * 0.5)
  if (out > 0 && vel > hi - out) gain *= Math.sin(((hi - vel) / out) * Math.PI * 0.5)
  return gain
}

function autoFades(zone: SampleZone, siblings: SampleZone[], width: number) {
  let fadeIn = 0
  let fadeOut = 0
  if (!(width > 0)) return { fadeIn, fadeOut }
  for (const other of siblings) {
    if (other === zone) continue
    const left = Math.max(zone.loVel, other.loVel)
    const right = Math.min(zone.hiVel, other.hiVel)
    if (right < left) continue
    const span = Math.min(width, right - left + 1)
    if (other.loVel < zone.loVel) fadeIn = Math.max(fadeIn, span)
    if (other.hiVel > zone.hiVel) fadeOut = Math.max(fadeOut, span)
  }
  return { fadeIn, fadeOut }
}

function articulationOk(zone: SampleZone, current: string) {
  if (!zone.articulation) return true
  return zone.articulation === current
}

function triggerOk(zone: SampleZone, trigger: SampleTrigger, held: number) {
  if (zone.trigger !== trigger) return false
  if (trigger === 'first') return held === 0
  if (trigger === 'legato') return held > 0
  return true
}

function micGain(zone: SampleZone, mics: Record<string, number>) {
  if (!zone.mic) return 1
  const gain = mics[zone.mic]
  return gain == null ? 1 : gain
}

function pickRobin(group: SampleZone[], state: SelectState) {
  const positions = [...new Set(group.map((zone) => zone.seqPosition))].filter((position) => position > 0).sort((a, b) => a - b)
  if (positions.length <= 1) return group
  const key = rrGroupKey(group[0])
  if (state.rrMode === 'random') {
    let index = Math.floor(state.random() * positions.length) % positions.length
    if (index < 0) index = 0
    const last = state.rr.get(key)
    if (positions.length > 1 && positions[index] === last) index = (index + 1) % positions.length
    const chosen = positions[index]
    state.rr.set(key, chosen)
    return group.filter((zone) => zone.seqPosition === chosen)
  }
  const cursor = state.rr.get(key) ?? 0
  const chosen = positions[cursor % positions.length]
  state.rr.set(key, cursor + 1)
  return group.filter((zone) => zone.seqPosition === chosen)
}

/**
 * Zones that should sound for this note.
 * Velocity is MIDI 1–127. Round-robin groups contribute one step.
 */
export function selectZones(zones: SampleZone[], note: number, midiVelocity: number, trigger: SampleTrigger, state: SelectState): ZonePick[] {
  const vel = Math.round(midiVelocity)
  if (vel <= 0) return []
  const matched = zones.filter((zone) => {
    if (note < zone.loKey || note > zone.hiKey) return false
    if (!articulationOk(zone, state.articulation)) return false
    if (!triggerOk(zone, trigger, state.held)) return false
    if (micGain(zone, state.mics) <= 0) return false
    return true
  })
  const groups = new Map<string, SampleZone[]>()
  const straight: SampleZone[] = []
  for (const zone of matched) {
    const key = rrGroupKey(zone)
    if (!key) straight.push(zone)
    else {
      const list = groups.get(key) ?? []
      list.push(zone)
      groups.set(key, list)
    }
  }
  const chosen = straight.slice()
  for (const group of groups.values()) chosen.push(...pickRobin(group, state))
  const picks: ZonePick[] = []
  for (const zone of chosen) {
    const explicit = zone.velFadeIn != null || zone.velFadeOut != null
    const auto = explicit ? { fadeIn: zone.velFadeIn ?? 0, fadeOut: zone.velFadeOut ?? 0 } : autoFades(zone, chosen, state.velFade)
    const layer = velocityLayerGain(vel, zone.loVel, zone.hiVel, auto.fadeIn, auto.fadeOut)
    if (layer <= 0) continue
    const gain = layer * zone.gain * (vel / 127) * micGain(zone, state.mics)
    if (gain <= 0) continue
    picks.push({ zone, gain })
  }
  return picks
}

export function keyswitchFor(articulations: { id: string; keyswitch: number }[], note: number) {
  return articulations.find((item) => item.keyswitch === note)?.id ?? null
}
