import type { FactoryPreset } from '../audio/plugins/types'

interface Rig {
  name: string
  model: number
  gain: number
  bass?: number
  mid?: number
  treble?: number
  presence?: number
  master?: number
  bright?: number
  cabA?: number
  cabB?: number
  blend?: number
  mic?: number
  axis?: number
  distance?: number
  pedals?: { id: number; a?: number; b?: number; post?: boolean }[]
}

function rig(spec: Rig): FactoryPreset {
  const params: Record<string, number> = {
    model: spec.model,
    gain: spec.gain,
    bass: spec.bass ?? 0.5,
    mid: spec.mid ?? 0.5,
    treble: spec.treble ?? 0.5,
    presence: spec.presence ?? 0.5,
    master: spec.master ?? 0.62,
    bright: spec.bright ?? 0,
    cab: 1,
    cabA: spec.cabA ?? 0,
    cabB: spec.cabB ?? 2,
    blend: spec.blend ?? 0,
    mic: spec.mic ?? 0,
    axis: spec.axis ?? 0,
    distance: spec.distance ?? 0.15,
    s0: 0,
  }
  spec.pedals?.forEach((pedal, index) => {
    params[`s${index}`] = pedal.id
    params[`a${index}`] = pedal.a ?? 0.5
    params[`b${index}`] = pedal.b ?? 0.4
    params[`z${index}`] = pedal.post ? 1 : 0
  })
  return { name: spec.name, params }
}

const p = (id: number, a = 0.5, b = 0.4, post = false) => ({ id, a, b, post })

/** Original rigs. Names describe the sound, not a product. */
export const AMP_PRESETS: FactoryPreset[] = [
  rig({ name: 'Glass Room', model: 0, gain: 0.22, bright: 1, treble: 0.62, cabA: 0, pedals: [p(1), p(3, 0.35), p(10, 0.28, 0.3)] }),
  rig({ name: 'Morning Neck', model: 0, gain: 0.18, bass: 0.58, treble: 0.48, cabA: 3, mic: 1 }),
  rig({ name: 'Spark Edge', model: 0, gain: 0.34, bright: 1, presence: 0.66, cabA: 0, pedals: [p(7, 0.4)] }),
  rig({ name: 'Soft Chorus', model: 0, gain: 0.2, cabA: 1, pedals: [p(10, 0.45, 0.35), p(17, 0.3, 0.7, true)] }),
  rig({ name: 'Country Glass', model: 0, gain: 0.28, bright: 1, treble: 0.7, cabA: 0, mic: 1, pedals: [p(3, 0.55), p(16, 0.32, 1, true)] }),
  rig({ name: 'Studio Clean', model: 0, gain: 0.16, bass: 0.46, mid: 0.48, treble: 0.55, cabA: 3, distance: 0.3 }),
  rig({ name: 'Small Room', model: 4, gain: 0.48, mid: 0.58, cabA: 3, pedals: [p(4, 0.35)] }),
  rig({ name: 'Edge Bite', model: 4, gain: 0.62, presence: 0.6, cabA: 1, pedals: [p(4, 0.55, 0.6)] }),
  rig({ name: 'Warm Break', model: 3, gain: 0.4, bass: 0.62, mid: 0.42, cabA: 0 }),
  rig({ name: 'Neck Blues', model: 3, gain: 0.55, bass: 0.66, treble: 0.4, cabA: 0, mic: 2, axis: 0.4 }),
  rig({ name: 'Tube Noon', model: 4, gain: 0.5, mid: 0.62, cabA: 1, pedals: [p(3, 0.4), p(17, 0.22, 0, true)] }),
  rig({ name: 'Stack Song', model: 1, gain: 0.58, mid: 0.64, cabA: 2, pedals: [p(4, 0.4)] }),
  rig({ name: 'Crunch Lane', model: 1, gain: 0.7, presence: 0.58, cabA: 2, cabB: 4, blend: 0.35 }),
  rig({ name: 'Mid Roar', model: 1, gain: 0.64, mid: 0.74, bass: 0.42, cabA: 2 }),
  rig({ name: 'Bright Stack', model: 1, gain: 0.52, bright: 1, treble: 0.68, cabA: 2, mic: 1 }),
  rig({ name: 'Power Chord', model: 1, gain: 0.76, bass: 0.6, mid: 0.55, cabA: 4, pedals: [p(5, 0.35)] }),
  rig({ name: 'Modern Tight', model: 2, gain: 0.72, bass: 0.58, mid: 0.36, presence: 0.62, cabA: 4, pedals: [p(2, 0.42, 0.2), p(7, 0.45)] }),
  rig({ name: 'Low Chug', model: 2, gain: 0.8, bass: 0.7, mid: 0.32, cabA: 4, pedals: [p(2, 0.5, 0.15)] }),
  rig({ name: 'Scoop Lead', model: 2, gain: 0.66, mid: 0.28, treble: 0.7, presence: 0.7, cabA: 2, pedals: [p(16, 0.28, 0.5, true)] }),
  rig({ name: 'Gate Gain', model: 2, gain: 0.84, bass: 0.56, mid: 0.4, cabA: 4, pedals: [p(2, 0.62, 0.1), p(5, 0.4)] }),
  rig({ name: 'Dark Palm', model: 2, gain: 0.74, treble: 0.36, presence: 0.32, cabA: 4, mic: 2, axis: 0.55 }),
  rig({ name: 'Wah Pocket', model: 0, gain: 0.3, mid: 0.6, cabA: 1, pedals: [p(3, 0.45), p(8, 0.45, 0.7), p(9, 0.55, 0.6)] }),
  rig({ name: 'Clean Snap', model: 0, gain: 0.24, bright: 1, cabA: 0, pedals: [p(3, 0.6), p(7, 0.35)] }),
  rig({ name: 'Filter Chop', model: 4, gain: 0.36, cabA: 1, pedals: [p(8, 0.4, 0.85), p(23, 0.6, 0.4)] }),
  rig({ name: 'Chord Stab', model: 0, gain: 0.26, cabA: 3, pedals: [p(3, 0.5), p(13, 0.35, 0.45)] }),
  rig({ name: 'Wide Wash', model: 0, gain: 0.2, cabA: 1, cabB: 3, blend: 0.4, pedals: [p(10, 0.4), p(16, 0.4, 1, true), p(17, 0.55, 1, true)] }),
  rig({ name: 'Spring Hall', model: 0, gain: 0.22, bright: 1, cabA: 0, pedals: [p(17, 0.48, 0, true), p(15, 0.3, 0.25, true)] }),
  rig({ name: 'Swell Pad', model: 4, gain: 0.3, cabA: 1, pedals: [p(11, 0.35, 0.3), p(17, 0.6, 1, true)] }),
  rig({ name: 'Bloom Delay', model: 0, gain: 0.18, cabA: 3, mic: 1, pedals: [p(16, 0.5, 0.5, true), p(17, 0.4, 0.7, true)] }),
  rig({ name: 'Dusty Amp', model: 3, gain: 0.48, treble: 0.32, cabA: 3, axis: 0.7, distance: 0.6, pedals: [p(6, 0.25, 0.3)] }),
  rig({ name: 'Tape Warble', model: 3, gain: 0.36, cabA: 0, mic: 2, pedals: [p(14, 0.4, 0.55), p(16, 0.3, 0.5, true)] }),
  rig({ name: 'Phone Cab', model: 4, gain: 0.42, treble: 0.28, presence: 0.3, cabA: 3, axis: 0.85, distance: 0.75 }),
  rig({ name: 'Soft Crush', model: 3, gain: 0.7, bass: 0.6, mid: 0.4, cabA: 4, pedals: [p(6, 0.45)] }),
  rig({ name: 'Wood Piezo', model: 5, gain: 0.12, bass: 0.42, treble: 0.6, cabA: 5, mic: 1, pedals: [p(3, 0.3)] }),
  rig({ name: 'Body Mic', model: 5, gain: 0.16, bass: 0.55, mid: 0.46, cabA: 5, mic: 2, distance: 0.35, axis: 0.3 }),
  rig({ name: 'Slap Snap', model: 7, gain: 0.2, bright: 1, treble: 0.66, cabA: 7, pedals: [p(3, 0.55), p(22, 0.25)] }),
  rig({ name: 'Finger Warm', model: 6, gain: 0.34, bass: 0.64, mid: 0.48, cabA: 6, pedals: [p(3, 0.4)] }),
  rig({ name: 'Pick Grind', model: 8, gain: 0.58, mid: 0.56, cabA: 8, pedals: [p(21, 0.45, 0.5)] }),
  rig({ name: 'Tube Low', model: 6, gain: 0.4, bass: 0.7, cabA: 6, mic: 0, pedals: [p(3, 0.35), p(22, 0.3)] }),
  rig({ name: 'Modern DI', model: 7, gain: 0.14, bass: 0.52, treble: 0.58, cabA: 7, mic: 1, distance: 0.1 }),
  rig({ name: 'Sub Growl', model: 8, gain: 0.5, bass: 0.72, mid: 0.4, cabA: 8, pedals: [p(22, 0.55), p(21, 0.35)] }),
  rig({ name: 'Drive Pocket', model: 8, gain: 0.46, mid: 0.6, cabA: 7, pedals: [p(23, 0.55, 0.45), p(21, 0.4)] }),
  rig({ name: 'Octave Lead', model: 1, gain: 0.6, presence: 0.64, cabA: 2, pedals: [p(18, 0.45), p(16, 0.25, 1, true)] }),
  rig({ name: 'Bend Dive', model: 2, gain: 0.58, cabA: 4, pedals: [p(19, 0.7, 0.25), p(2, 0.4)] }),
  rig({ name: 'Loop Bed', model: 0, gain: 0.24, cabA: 1, pedals: [p(20, 0.6), p(17, 0.35, 0.7, true)] }),
]
