import type { LoopMode, SampleTrigger, SampleZone } from './types'

export function makeZone(partial: Partial<SampleZone> & Pick<SampleZone, 'id' | 'sampleId'>): SampleZone {
  return {
    root: 60,
    loKey: 0,
    hiKey: 127,
    loVel: 0,
    hiVel: 127,
    tune: 0,
    gain: 1,
    pan: 0,
    start: 0,
    end: 0,
    loopStart: 0,
    loopEnd: 0,
    loopMode: 'none',
    loopCrossfade: 0,
    velFadeIn: null,
    velFadeOut: null,
    seqPosition: 0,
    seqLength: 1,
    articulation: '',
    mic: '',
    trigger: 'attack',
    group: 0,
    offBy: 0,
    attack: null,
    decay: null,
    sustain: null,
    release: null,
    ...partial,
  }
}

export function clampNote(value: number) {
  if (!Number.isFinite(value)) return 60
  return Math.max(0, Math.min(127, Math.round(value)))
}

export function dbToGain(db: number) {
  if (!Number.isFinite(db)) return 1
  return 10 ** (db / 20)
}

export function loopFromName(name: string): LoopMode {
  const mode = name.toLowerCase()
  if (mode.includes('ping')) return 'pingpong'
  if (mode.includes('sustain')) return 'sustain'
  if (mode.includes('one')) return 'oneshot'
  if (mode.includes('no') || mode.includes('off') || mode === '0' || mode === 'false') return 'none'
  if (mode.includes('loop') || mode === '1' || mode === 'true' || mode === 'continuous') return 'forward'
  return 'none'
}

export function triggerFromName(name: string): SampleTrigger {
  const trigger = name.toLowerCase()
  if (trigger.includes('release')) return 'release'
  if (trigger.includes('legato')) return 'legato'
  if (trigger.includes('first')) return 'first'
  return 'attack'
}
