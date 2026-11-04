import { DEVICE_PRESET_IDS, deviceDrafts } from './devices'
import type { CuePreset } from './types'
import { INIT_NAME } from './types'

export const PRESET_PLUGINS = [
  'eq',
  'compressor',
  'saturator',
  'amp',
  'vocal',
  'reverb',
  'delay',
  'mod',
  'limiter',
  'tune',
  'synth',
  'sampler',
  'scaler',
  'steps',
  'pads',
  'master',
] as const

export type PresetPluginId = (typeof PRESET_PLUGINS)[number]

interface Draft {
  name: string
  params: Record<string, number>
  text?: Record<string, string>
}

function pack(pluginId: string, drafts: Draft[]): CuePreset[] {
  return drafts.map((draft) => ({
    id: `factory:${pluginId}:${draft.name}`,
    pluginId,
    name: draft.name,
    source: 'factory' as const,
    params: draft.params,
    text: draft.text,
  }))
}

function groove(name: string, swing: number, kick: number[], snare: number[], hat: number[]): Draft {
  const params: Record<string, number> = { swing }
  for (let step = 0; step < 16; step += 1) {
    params[`k${step}`] = kick.includes(step) ? 1 : 0
    params[`s${step}`] = snare.includes(step) ? 1 : 0
    params[`h${step}`] = hat.includes(step) ? 1 : 0
  }
  return { name, params }
}

const FACTORY_DRAFTS: Record<PresetPluginId, Draft[]> = {
  eq: [
    { name: 'Vocal Presence', params: { hp: 80, lowF: 250, lowG: -2, midF: 3200, midG: 3, midQ: 1.1, highF: 10000, highG: 2, lp: 18000 } },
    { name: 'Kick Punch', params: { hp: 30, lowF: 70, lowG: 4, lowQ: 1.2, midF: 400, midG: -3, midQ: 1.4, highG: 1 } },
    { name: 'Low Cut 80 Hz', params: { hp: 80, lowG: -1, lowF: 160 } },
    { name: 'Telephone', params: { hp: 300, lp: 3400, midF: 1500, midG: 4, midQ: 0.7, lowG: -8, highG: -6 } },
    { name: 'Air Lift', params: { hp: 40, highF: 12000, highG: 4.5, highQ: 0.6, midG: 0.5 } },
    { name: 'Mud Cut', params: { hp: 30, lowF: 250, lowG: -3.5, lowQ: 0.9, midF: 350, midG: -1.5 } },
    { name: 'Snare Snap', params: { hp: 80, midF: 2500, midG: 3.5, midQ: 1.6, highF: 8000, highG: 2 } },
    { name: 'Sub Control', params: { hp: 25, lowF: 60, lowG: -2, lowQ: 0.8, midF: 180, midG: -1 } },
  ],
  compressor: [
    { name: 'Vocal Leveling', params: { kind: 0, threshold: -18, ratio: 3, attack: 8, release: 120, knee: 6, makeup: 3, mix: 1 } },
    { name: 'Drum Bus Glue', params: { kind: 0, threshold: -12, ratio: 2, attack: 20, release: 160, knee: 8, makeup: 2, mix: 0.7 } },
    { name: 'Parallel Smash', params: { kind: 0, threshold: -28, ratio: 8, attack: 0.5, release: 70, knee: 3, makeup: 8, mix: 0.4 } },
    { name: 'Bass Control', params: { kind: 0, threshold: -20, ratio: 4, attack: 25, release: 180, knee: 6, makeup: 2, mix: 1, hpf: 90 } },
    { name: 'Gentle Mix', params: { kind: 0, threshold: -14, ratio: 1.5, attack: 30, release: 200, knee: 12, makeup: 1, mix: 1 } },
    { name: 'Fast Peak', params: { kind: 0, threshold: -16, ratio: 6, attack: 0.4, release: 40, knee: 2, makeup: 3, mix: 1 } },
    { name: 'Soft Verse', params: { kind: 0, threshold: -22, ratio: 2.5, attack: 12, release: 140, knee: 10, makeup: 2, mix: 0.85 } },
    { name: 'NY Parallel', params: { kind: 0, threshold: -32, ratio: 10, attack: 1, release: 90, knee: 4, makeup: 10, mix: 0.35 } },
  ],
  saturator: [
    { name: 'Tape Warmth', params: { kind: 1, drive: 0.28, tone: 6000, mix: 0.55, speed: 1, bias: 0.35, wow: 0.08, bump: 0.3 } },
    { name: 'Tube Glow', params: { kind: 2, drive: 0.22, tube: 0.6 } },
    { name: 'Console Dirt', params: { kind: 0, drive: 0.18, tone: 8000, mix: 0.4 } },
    { name: 'Drum Crush', params: { kind: 0, drive: 0.55, tone: 4500, mix: 0.65 } },
    { name: 'Bass Growl', params: { kind: 0, drive: 0.42, tone: 2200, mix: 0.6 } },
    { name: 'Vocal Sheen', params: { kind: 1, drive: 0.16, bias: 0.25, hiss: 0.02, wow: 0.06, bump: 0.2 } },
    { name: 'Lo-fi Tape', params: { kind: 1, drive: 0.48, wow: 0.35, hiss: 0.2, bump: 0.45, bias: 0.55 } },
    { name: 'Soft Clip', params: { kind: 4, drive: 0.3, clipMode: 0, ceiling: -0.3 } },
  ],
  amp: [
    { name: 'Studio Clean', params: { model: 0, gain: 0.16, bass: 0.46, mid: 0.48, treble: 0.55, presence: 0.42, master: 0.6, cabA: 3, distance: 0.3 } },
    { name: 'Glass Room', params: { model: 0, gain: 0.22, bright: 1, treble: 0.62, presence: 0.5, master: 0.62, cabA: 0, s0: 1, a0: 0.45 } },
    { name: 'Stack Song', params: { model: 1, gain: 0.58, bass: 0.52, mid: 0.64, treble: 0.5, presence: 0.48, master: 0.66, cabA: 2 } },
    { name: 'Crunch Lane', params: { model: 1, gain: 0.7, bass: 0.48, mid: 0.5, treble: 0.58, presence: 0.58, master: 0.64, cabA: 2, cabB: 4, blend: 0.35 } },
    { name: 'Modern Tight', params: { model: 2, gain: 0.72, bass: 0.58, mid: 0.36, treble: 0.55, presence: 0.62, master: 0.68, cabA: 4, s0: 2, a0: 0.42 } },
    { name: 'Neck Blues', params: { model: 3, gain: 0.55, bass: 0.66, mid: 0.48, treble: 0.4, presence: 0.36, master: 0.6, cabA: 0, mic: 2, axis: 0.4 } },
    { name: 'Edge Bite', params: { model: 4, gain: 0.62, bass: 0.5, mid: 0.58, treble: 0.52, presence: 0.6, master: 0.64, cabA: 1 } },
    { name: 'Finger Warm', params: { model: 6, gain: 0.34, bass: 0.64, mid: 0.48, treble: 0.46, presence: 0.4, master: 0.62, cabA: 6 } },
  ],
  vocal: [
    { name: 'Vocal De-ess', params: { kind: 1, freq: 6800, threshold: -22, amount: 0.55 } },
    { name: 'Hard Sibilance', params: { kind: 1, freq: 6000, threshold: -28, amount: 0.85 } },
    { name: 'Gentle Gate', params: { kind: 2, gate: -42, gateRatio: 6, gateAtk: 4, gateRel: 110, hold: 30, range: 24 } },
    { name: 'Podcast Gate', params: { kind: 2, gate: -38, gateRatio: 10, gateAtk: 2, gateRel: 80, hold: 40, range: 40 } },
    { name: 'Bright De-ess', params: { kind: 1, freq: 8000, threshold: -20, amount: 0.4 } },
    { name: 'Close Mic', params: { kind: 0, freq: 6500, threshold: -24, amount: 0.45, gate: -46, gateRatio: 8, range: 30 } },
    { name: 'Soft Air', params: { kind: 1, freq: 9000, threshold: -18, amount: 0.25 } },
    { name: 'Stage Gate', params: { kind: 2, gate: -32, gateRatio: 14, gateAtk: 1, gateRel: 50, hold: 15, range: 60 } },
  ],
  reverb: [
    { name: 'Small Room', params: { kind: 0, mode: 1, size: 0.28, decay: 0.4, damp: 0.55, mix: 0.16 } },
    { name: 'Plate Vocal', params: { kind: 1, mode: 0, size: 0.48, decay: 0.7, damp: 0.32, mix: 0.22 } },
    { name: 'Large Hall', params: { kind: 2, mode: 1, size: 0.92, decay: 0.94, damp: 0.28, mix: 0.28 } },
    { name: 'Drum Room', params: { kind: 0, mode: 0, size: 0.32, decay: 0.36, damp: 0.6, mix: 0.14 } },
    { name: 'Ambience', params: { kind: 0, mode: 2, size: 0.18, decay: 0.28, damp: 0.45, mix: 0.12 } },
    { name: 'Dark Hall', params: { kind: 2, mode: 1, size: 0.8, decay: 0.88, damp: 0.72, mix: 0.24 } },
    { name: 'Bright Plate', params: { kind: 1, mode: 0, size: 0.42, decay: 0.62, damp: 0.18, mix: 0.2 } },
    { name: 'Spring Slap', params: { kind: 0, mode: 0, size: 0.22, decay: 0.32, damp: 0.4, mix: 0.18 } },
  ],
  delay: [
    { name: 'Slapback', params: { kind: 0, sync: 0, time: 110, feedback: 0.12, pingpong: 0, filter: 6000, mix: 0.28 } },
    { name: '1/4 Ping-Pong', params: { kind: 0, sync: 1, division: 1, feedback: 0.35, pingpong: 1, filter: 5000, mix: 0.3 } },
    { name: 'Dub Throw', params: { kind: 1, sync: 0, time: 450, feedback: 0.62, filter: 2800, wow: 0.35, drive: 0.3, mix: 0.34 } },
    { name: 'Eighth Note', params: { kind: 0, sync: 1, division: 0.5, feedback: 0.28, pingpong: 0, filter: 5500, mix: 0.24 } },
    { name: 'Dotted Eighth', params: { kind: 0, sync: 1, division: 0.75, feedback: 0.4, pingpong: 1, filter: 4200, mix: 0.28 } },
    { name: 'Stereo Throw', params: { kind: 0, sync: 1, division: 0.375, feedback: 0.45, pingpong: 1, filter: 3800, mix: 0.32 } },
    { name: 'Short Double', params: { kind: 0, sync: 0, time: 28, feedback: 0.08, pingpong: 0, filter: 8000, mix: 0.22 } },
    { name: 'Filtered Echo', params: { kind: 1, sync: 0, time: 320, feedback: 0.4, filter: 1800, wow: 0.2, drive: 0.2, mix: 0.26 } },
  ],
  mod: [
    { name: 'Soft Chorus', params: { kind: 0, rate: 0.3, depth: 0.35, mix: 0.3 } },
    { name: 'Wide Ensemble', params: { kind: 2, rate: 0.18, depth: 0.55, mode: 1, mix: 0.42 } },
    { name: 'Slow Phaser', params: { kind: 3, rate: 0.12, depth: 0.6, feedback: 0.45, mix: 0.4 } },
    { name: 'Rotary Slow', params: { kind: 4, speed: 0, mix: 0.55 } },
    { name: 'Tape Double', params: { kind: 1, width: 0.7, delay: 22, depth: 0.3, mix: 0.4 } },
    { name: 'Shimmer Fifth', params: { kind: 5, semis: 0, harmony: 7, harmonyMix: 0.45, mix: 0.55 } },
    { name: 'Tremolo', params: { kind: 0, rate: 3.2, depth: 0.7, mix: 0.65 } },
    { name: 'Subtle Widen', params: { kind: 1, width: 0.4, delay: 14, depth: 0.15, mix: 0.25 } },
  ],
  limiter: [
    { name: 'Transparent Ceiling', params: { kind: 0, threshold: 0, release: 40, ceiling: -0.3 } },
    { name: 'Streaming -14', params: { kind: 2, ceiling: -1, target: -14, release: 140, lookahead: 5, width: 1 } },
    { name: 'Club Loud', params: { kind: 2, target: -8, ceiling: -0.3, release: 80, width: 1.1 } },
    { name: 'Podcast Safe', params: { kind: 0, threshold: -6, ceiling: -1.5, release: 100 } },
    { name: 'Gentle Catch', params: { kind: 0, threshold: -3, ceiling: -0.8, release: 70 } },
    { name: 'Drum Peak', params: { kind: 0, threshold: -2, ceiling: -0.5, release: 25 } },
    { name: 'Master Glue', params: { kind: 0, threshold: -4, ceiling: -0.8, release: 120 } },
    { name: 'Broadcast', params: { kind: 2, ceiling: -1, target: -16, release: 160, lookahead: 6, width: 1 } },
  ],
  tune: [
    { name: 'Natural', params: { retune: 0.42, humanize: 0.55, flex: 0.35, amount: 0.72, mode: 1 } },
    { name: 'Hard Tune', params: { retune: 0.95, humanize: 0.05, flex: 0, amount: 0.9, mode: 1 } },
    { name: 'Pop Vocal', params: { retune: 0.72, humanize: 0.25, flex: 0.15, amount: 0.82, formant: 0.1, mode: 1 } },
    { name: 'Subtle Pitch', params: { retune: 0.28, humanize: 0.7, flex: 0.5, amount: 0.45, mode: 1 } },
    { name: 'Robotic', params: { retune: 1, humanize: 0, flex: 0, amount: 1, mode: 1, vibrato: 0 } },
    { name: 'Low Voice', params: { retune: 0.5, humanize: 0.4, amount: 0.75, minHz: 70, maxHz: 420, mode: 1 } },
    { name: 'Bright Formant', params: { retune: 0.6, humanize: 0.3, amount: 0.8, formant: 0.45, mode: 1 } },
    { name: 'Instrument', params: { retune: 0.88, humanize: 0.1, amount: 0.9, mode: 0, minHz: 50, maxHz: 1400 } },
  ],
  synth: [
    { name: 'Analog Bass', params: { cutoff: 280, res: 0.42, mix2: 0.45, detune: 8, famt: 0.55, decay: 180, sustain: 0.4, drive: 0.25, glide: 40 } },
    { name: 'Warm Pad', params: { attack: 480, decay: 800, sustain: 0.75, release: 1200, cutoff: 2400, mix2: 0.5, mix3: 0.2, famt: 0.15, uni: 2, uniDet: 12 } },
    { name: 'Soft Pluck', params: { attack: 2, decay: 160, sustain: 0.1, release: 180, cutoff: 3200, famt: 0.65, res: 0.2 } },
    { name: 'Supersaw', params: { uni: 4, uniDet: 18, mix2: 0.7, cutoff: 5000, res: 0.1, drive: 0.15, sustain: 0.7 } },
    { name: 'Keys', params: { attack: 4, decay: 280, sustain: 0.45, release: 220, cutoff: 4200, famt: 0.4, mix2: 0.2 } },
    { name: 'PWM Lead', params: { pw: 0.3, cutoff: 2800, res: 0.35, lfo1: 4, mod1amt: 0.25, sustain: 0.8, mix1: 0.9 } },
    { name: 'Sub Drop', params: { cutoff: 120, res: 0.15, mix2: 0, decay: 400, sustain: 0, famt: 0.2, glide: 80 } },
    { name: 'Bell Stack', params: { mix3: 0.45, cutoff: 6000, attack: 2, decay: 700, sustain: 0.15, release: 900, res: 0.1 } },
  ],
  sampler: [
    { name: 'One Shot', params: { stretch: 0, keys: 0, loopMode: 2, attack: 1, decay: 200, sustain: 1, release: 40 } },
    { name: 'Sustained Keys', params: { keys: 1, stretch: 0, loopMode: 0, attack: 8, sustain: 0.85, release: 280, cutoff: 12000 } },
    { name: 'Loop', params: { stretch: 1, keys: 0, loopMode: 0, crossfade: 0.06, attack: 4, sustain: 1 } },
    { name: 'Short Pluck', params: { keys: 1, attack: 1, decay: 120, sustain: 0, release: 80, cutoff: 5000 } },
    { name: 'Pad Layer', params: { keys: 1, attack: 300, decay: 800, sustain: 0.8, release: 900, cutoff: 8000 } },
    { name: 'Drum Hit', params: { stretch: 0, keys: 0, loopMode: 2, attack: 1, decay: 80, sustain: 0, release: 20 } },
    { name: 'Chop', params: { stretch: 0, sensitivity: 0.62, loopMode: 2, attack: 1, release: 30 } },
    { name: 'Soft Attack', params: { keys: 1, attack: 40, decay: 400, sustain: 0.7, release: 240, cutoff: 9000 } },
  ],
  scaler: [
    { name: 'Pop Triads', params: { root: 0, inversion: 0, gate: 0.8, rate: 0.5, swing: 0, octaves: 1, snap: 1, voiceLead: 1 }, text: { scale: 'ionian', group: 'triad', voicing: 'close', sound: 'synth', arp: 'off', rhythm: 'block' } },
    { name: 'Soul Sevenths', params: { root: 9, inversion: 1, gate: 0.85, rate: 0.5, swing: 0.08, octaves: 1, snap: 1, voiceLead: 1 }, text: { scale: 'dorian', group: 'seventh', voicing: 'drop2', sound: 'synth', arp: 'off', rhythm: 'block' } },
    { name: 'Minor Ballad', params: { root: 4, inversion: 0, gate: 1, rate: 1, swing: 0, octaves: 1, snap: 1, voiceLead: 1 }, text: { scale: 'aeolian', group: 'triad', voicing: 'spread', sound: 'synth', arp: 'off', rhythm: 'block' } },
    { name: 'House Stabs', params: { root: 7, inversion: 0, gate: 0.25, rate: 0.5, swing: 0, octaves: 1, snap: 1, voiceLead: 0 }, text: { scale: 'aeolian', group: 'triad', voicing: 'close', sound: 'synth', arp: 'off', rhythm: 'block' } },
    { name: 'Jazz Drop 2', params: { root: 2, inversion: 1, gate: 0.8, rate: 0.5, swing: 0.16, octaves: 1, snap: 1, voiceLead: 1 }, text: { scale: 'dorian', group: 'seventh', voicing: 'drop2', sound: 'synth', arp: 'off', rhythm: 'block' } },
    { name: 'Trap Minor', params: { root: 10, inversion: 0, gate: 0.5, rate: 0.25, swing: 0.08, octaves: 1, snap: 1, voiceLead: 1 }, text: { scale: 'minorPentatonic', group: 'triad', voicing: 'close', sound: '808', arp: 'off', rhythm: 'block' } },
    { name: 'Gospel Spread', params: { root: 5, inversion: 0, gate: 0.9, rate: 0.5, swing: 0.08, octaves: 1, snap: 1, voiceLead: 1 }, text: { scale: 'ionian', group: 'seventh', voicing: 'spread', sound: 'synth', arp: 'off', rhythm: 'block' } },
    { name: 'Arp Up', params: { root: 0, inversion: 0, gate: 0.5, rate: 0.25, swing: 0, octaves: 2, snap: 1, voiceLead: 1 }, text: { scale: 'ionian', group: 'triad', voicing: 'close', sound: 'synth', arp: 'up', rhythm: 'block' } },
  ],
  steps: [
    groove('Four on the Floor', 0, [0, 4, 8, 12], [4, 12], [2, 6, 10, 14]),
    groove('Boom Bap', 0.16, [0, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14]),
    groove('Trap Hats', 0.08, [0, 7, 10], [4, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    groove('House', 0, [0, 4, 8, 12], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14]),
    groove('Disco', 0, [0, 4, 8, 12], [4, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    groove('Half Time', 0.1, [0], [8], [2, 6, 10, 14]),
    groove('Reggae', 0, [4, 12], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14]),
    groove('Funk', 0.2, [0, 3, 6, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14]),
  ],
  pads: [
    { name: 'Tight Kit', params: { tune: 2, decay: 0.45, attack: 0, swing: 50, humanize: 0, level: 0.85 } },
    { name: 'Room Kit', params: { tune: -2, decay: 1, attack: 0.02, swing: 54, humanize: 0.02, level: 0.8 } },
    { name: 'Boom Bap', params: { tune: -4, decay: 0.85, attack: 0, swing: 62, humanize: 0.04, level: 0.82 } },
    { name: 'Trap', params: { tune: 3, decay: 0.55, attack: 0, swing: 58, humanize: 0.03, level: 0.9 } },
    { name: 'House', params: { tune: 1, decay: 0.6, attack: 0, swing: 50, humanize: 0, level: 0.88 } },
    { name: 'Lo-fi', params: { tune: -6, decay: 0.75, attack: 0.04, swing: 60, humanize: 0.08, level: 0.7 } },
    { name: 'Rock', params: { tune: 0, decay: 0.7, attack: 0, swing: 50, humanize: 0.01, level: 0.9 } },
    { name: 'Dry Close', params: { tune: 1, decay: 0.35, attack: 0, swing: 50, humanize: 0, level: 0.78 } },
  ],
  master: [
    { name: 'Streaming -14', params: { kind: 2, ceiling: -1, target: -14, release: 140, lookahead: 5, width: 1 } },
    { name: 'Club', params: { kind: 2, ceiling: -0.3, target: -8, release: 80, width: 1.12 } },
    { name: 'Podcast', params: { kind: 0, ceiling: -1.5, threshold: -6, release: 120, width: 1 } },
    { name: 'Vinyl Warm', params: { kind: 0, ceiling: -1, threshold: -3, release: 160, width: 0.95 } },
    { name: 'Gentle Master', params: { kind: 0, ceiling: -1, threshold: -2, release: 100, width: 1 } },
    { name: 'Loud Pop', params: { kind: 2, ceiling: -0.5, target: -9, release: 70, width: 1.08 } },
    { name: 'Jazz Dynamic', params: { kind: 0, ceiling: -1.2, threshold: -1, release: 180, width: 1 } },
    { name: 'Broadcast', params: { kind: 2, ceiling: -1, target: -16, release: 150, lookahead: 6, width: 1 } },
  ],
}

export function factoryPresets(pluginId: string): CuePreset[] {
  const drafts = FACTORY_DRAFTS[pluginId as PresetPluginId] ?? deviceDrafts(pluginId)
  return pack(pluginId, drafts)
}

export function allFactoryPresets(): CuePreset[] {
  return [...PRESET_PLUGINS, ...DEVICE_PRESET_IDS].flatMap((pluginId) => factoryPresets(pluginId))
}

export function initPreset(pluginId: string): CuePreset {
  return { id: `init:${pluginId}`, pluginId, name: INIT_NAME, source: 'init', params: {} }
}
