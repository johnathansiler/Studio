import { uid, type Project, type Track } from './types'

export type DeviceKind =
  | 'sub'
  | 'fm'
  | 'sampler'
  | 'drum'
  | 'eq'
  | 'comp'
  | 'delay'
  | 'reverb'
  | 'chorus'
  | 'dist'
  | 'filter'
  | 'mix'
  | 'split'
  | 'seq'
  | 'arp'

export interface SampleZone {
  id: string
  bufferId: string
  root: number
  lo: number
  hi: number
  loopStart: number
  loopEnd: number
  tune: number
}

export interface DrumPad {
  bufferId: string
  tune: number
  decay: number
}

export interface RackDevice {
  id: string
  kind: DeviceKind
  name: string
  params: Record<string, number>
  zones: SampleZone[]
  pads: DrumPad[]
  /** 16 steps. Each value is a bitmask of the 16 pads. */
  pattern: number[]
}

export interface Cable {
  id: string
  from: string
  fromPort: string
  to: string
  toPort: string
  amount: number
}

export interface RackState {
  devices: RackDevice[]
  cables: Cable[]
  polyphony: number
}

export interface DevicePreset {
  id: string
  kind: DeviceKind
  name: string
  params: Record<string, number>
}

export interface RackPatch {
  id: string
  name: string
  rack: RackState
}

export interface RackAutomation {
  id: string
  deviceId: string
  param: string
  points: { beat: number; value: number }[]
}

export interface ParamSpec {
  id: string
  name: string
  min: number
  max: number
  default: number
  unit: string
}

const spec = (id: string, name: string, min: number, max: number, fallback: number, unit = ''): ParamSpec => ({
  id, name, min, max, default: fallback, unit,
})

export const DEVICE_PARAMS: Record<DeviceKind, ParamSpec[]> = {
  sub: [
    spec('mix1', 'Osc 1', 0, 1, 0.7),
    spec('mix2', 'Osc 2', 0, 1, 0.25),
    spec('mix3', 'Osc 3', 0, 1, 0),
    spec('wave1', 'Wave', 0, 2, 0),
    spec('detune', 'Detune', -40, 40, 6, 'ct'),
    spec('cutoff', 'Cutoff', 40, 8000, 1400, 'Hz'),
    spec('res', 'Res', 0, 0.9, 0.15),
    spec('attack', 'Attack', 1, 2000, 8, 'ms'),
    spec('decay', 'Decay', 5, 3000, 240, 'ms'),
    spec('sustain', 'Sustain', 0, 1, 0.7),
    spec('release', 'Release', 5, 4000, 280, 'ms'),
    spec('famt', 'F Env', -1, 1, 0.35),
    spec('fattack', 'F Atk', 1, 2000, 12, 'ms'),
    spec('fdecay', 'F Dec', 5, 3000, 280, 'ms'),
    spec('fsustain', 'F Sus', 0, 1, 0.3),
    spec('frelease', 'F Rel', 5, 4000, 300, 'ms'),
    spec('lfo1', 'LFO', 0.05, 12, 0.4, 'Hz'),
    spec('lfo2', 'LFO 2', 0.05, 12, 2, 'Hz'),
    spec('mod1src', 'Mod src', 0, 3, 0),
    spec('mod1dst', 'Mod dst', 0, 2, 0),
    spec('mod1amt', 'Mod', -1, 1, 0),
    spec('mod2src', 'Mod 2 src', 0, 3, 1),
    spec('mod2dst', 'Mod 2 dst', 0, 2, 1),
    spec('mod2amt', 'Mod 2', -1, 1, 0),
  ],
  fm: [
    spec('mode', 'Mode', 0, 1, 0),
    spec('ratio', 'Ratio', 0.5, 8, 2),
    spec('index', 'Index', 0, 6, 1.4),
    spec('attack', 'Attack', 1, 2000, 6, 'ms'),
    spec('decay', 'Decay', 5, 3000, 200, 'ms'),
    spec('sustain', 'Sustain', 0, 1, 0.6),
    spec('release', 'Release', 5, 4000, 240, 'ms'),
  ],
  sampler: [
    spec('attack', 'Attack', 1, 2000, 4, 'ms'),
    spec('decay', 'Decay', 5, 3000, 180, 'ms'),
    spec('sustain', 'Sustain', 0, 1, 0.8),
    spec('release', 'Release', 5, 4000, 200, 'ms'),
    spec('loop', 'Loop', 0, 1, 1),
    spec('tune', 'Tune', -24, 24, 0, 'st'),
  ],
  drum: [
    spec('swing', 'Swing', 0, 0.6, 0),
    spec('level', 'Level', 0, 1, 0.8),
  ],
  eq: [
    spec('low', 'Low', -18, 12, 0, 'dB'),
    spec('mid', 'Mid', -18, 12, 0, 'dB'),
    spec('midF', 'Freq', 200, 8000, 1200, 'Hz'),
    spec('high', 'High', -18, 12, 0, 'dB'),
  ],
  comp: [
    spec('threshold', 'Thresh', -40, 0, 0, 'dB'),
    spec('ratio', 'Ratio', 1, 12, 1),
    spec('attack', 'Attack', 1, 80, 10, 'ms'),
    spec('release', 'Release', 10, 400, 120, 'ms'),
    spec('makeup', 'Makeup', 0, 12, 0, 'dB'),
  ],
  delay: [
    spec('time', 'Time', 0.05, 1, 0.375, 'beat'),
    spec('feedback', 'Feedback', 0, 0.85, 0.35),
    spec('mix', 'Mix', 0, 1, 0.22),
  ],
  reverb: [
    spec('size', 'Size', 0.2, 1, 0.55),
    spec('mix', 'Mix', 0, 1, 0.18),
  ],
  chorus: [
    spec('rate', 'Rate', 0.05, 4, 0.35, 'Hz'),
    spec('depth', 'Depth', 0, 1, 0.4),
    spec('mix', 'Mix', 0, 1, 0.25),
  ],
  dist: [
    spec('drive', 'Drive', 0, 1, 0.35),
    spec('mix', 'Mix', 0, 1, 0.4),
  ],
  filter: [
    spec('cutoff', 'Cutoff', 40, 12000, 4000, 'Hz'),
    spec('res', 'Res', 0, 0.9, 0.1),
    spec('mode', 'Mode', 0, 1, 0),
  ],
  mix: [spec('gain', 'Gain', 0, 1.5, 1)],
  split: [spec('gain', 'Gain', 0, 1.5, 1)],
  seq: [
    spec('rate', 'Rate', 0.25, 4, 1, 'beat'),
    spec('s0', '1', 0, 1, 0),
    spec('s1', '2', 0, 1, 0.2),
    spec('s2', '3', 0, 1, 0.5),
    spec('s3', '4', 0, 1, 0.8),
    spec('s4', '5', 0, 1, 0.4),
    spec('s5', '6', 0, 1, 0.1),
    spec('s6', '7', 0, 1, 0.6),
    spec('s7', '8', 0, 1, 0.3),
  ],
  arp: [
    spec('rate', 'Rate', 0.125, 2, 0.25, 'beat'),
    spec('mode', 'Mode', 0, 2, 0),
    spec('gate', 'Gate', 0.05, 1, 0.7),
    spec('octaves', 'Oct', 1, 3, 1),
  ],
}

export const DEVICE_NAMES: Record<DeviceKind, string> = {
  sub: 'Sub',
  fm: 'FM',
  sampler: 'Sampler',
  drum: 'Drums',
  eq: 'EQ',
  comp: 'Comp',
  delay: 'Delay',
  reverb: 'Reverb',
  chorus: 'Chorus',
  dist: 'Dist',
  filter: 'Filter',
  mix: 'Mix',
  split: 'Split',
  seq: 'Seq',
  arp: 'Arp',
}

export const DEVICE_KINDS = Object.keys(DEVICE_NAMES) as DeviceKind[]

export const FACTORY_PRESETS: Record<DeviceKind, { name: string; params: Record<string, number> }[]> = {
  sub: [
    { name: 'Init', params: {} },
    { name: 'Bass', params: { cutoff: 420, res: 0.35, mix2: 0.4, detune: 8, famt: 0.55, decay: 180, sustain: 0.4 } },
    { name: 'Pad', params: { attack: 420, release: 900, cutoff: 2200, mix2: 0.45, mix3: 0.2, famt: 0.2 } },
    { name: 'Pluck', params: { attack: 2, decay: 160, sustain: 0.1, release: 180, cutoff: 3200, famt: 0.7 } },
  ],
  fm: [
    { name: 'Bell', params: { ratio: 3.5, index: 2.2, decay: 400, sustain: 0.2 } },
    { name: 'Bass', params: { ratio: 1, index: 2.8, decay: 140, sustain: 0.35 } },
    { name: 'Keys', params: { mode: 1, index: 1.2, attack: 4, decay: 260, sustain: 0.55 } },
  ],
  sampler: [
    { name: 'One shot', params: { loop: 0, attack: 2, sustain: 1, release: 80 } },
    { name: 'Loop', params: { loop: 1, attack: 8, sustain: 0.85 } },
  ],
  drum: [{ name: 'Kit', params: { level: 0.85, swing: 0.08 } }],
  eq: [
    { name: 'Flat', params: {} },
    { name: 'Air', params: { high: 3, low: -1 } },
  ],
  comp: [
    { name: 'Off', params: { ratio: 1, threshold: 0 } },
    { name: 'Glue', params: { threshold: -16, ratio: 3, makeup: 2 } },
  ],
  delay: [
    { name: 'Eighth', params: { time: 0.5, feedback: 0.32, mix: 0.24 } },
    { name: 'Dotted', params: { time: 0.75, feedback: 0.4, mix: 0.28 } },
  ],
  reverb: [
    { name: 'Room', params: { size: 0.35, mix: 0.16 } },
    { name: 'Hall', params: { size: 0.8, mix: 0.22 } },
  ],
  chorus: [{ name: 'Wide', params: { rate: 0.3, depth: 0.55, mix: 0.35 } }],
  dist: [{ name: 'Warm', params: { drive: 0.45, mix: 0.5 } }],
  filter: [{ name: 'Open', params: { cutoff: 6000, res: 0.1, mode: 0 } }],
  mix: [{ name: 'Unity', params: { gain: 1 } }],
  split: [{ name: 'Unity', params: { gain: 1 } }],
  seq: [{ name: 'Rise', params: { s0: 0, s1: 0.25, s2: 0.5, s3: 0.75, s4: 1, s5: 0.6, s6: 0.3, s7: 0.1 } }],
  arp: [
    { name: 'Up', params: { mode: 0, rate: 0.25, gate: 0.6 } },
    { name: 'Down', params: { mode: 1, rate: 0.25, gate: 0.6 } },
  ],
}

export function defaults(kind: DeviceKind) {
  const params: Record<string, number> = {}
  for (const item of DEVICE_PARAMS[kind]) params[item.id] = item.default
  return params
}

export function defaultPads(): DrumPad[] {
  return Array.from({ length: 16 }, (_, index) => ({
    bufferId: '',
    tune: index < 4 ? -12 + index * 7 : index,
    decay: index % 4 === 0 ? 0.18 : 0.35,
  }))
}

export function makeDevice(kind: DeviceKind, preset?: string): RackDevice {
  const params = defaults(kind)
  const chosen = FACTORY_PRESETS[kind].find((item) => item.name === preset)
  if (chosen) Object.assign(params, chosen.params)
  const pattern = Array(16).fill(0)
  if (kind === 'drum') {
    pattern[0] = 1
    pattern[4] = 1 << 2
    pattern[8] = 1
    pattern[12] = 1 << 2
  }
  return {
    id: uid('dev'),
    kind,
    name: DEVICE_NAMES[kind],
    params,
    zones: [],
    pads: defaultPads(),
    pattern,
  }
}

export function defaultRack(): RackState {
  return { devices: [makeDevice('sub', 'Init')], cables: [], polyphony: 8 }
}

export function isInstrument(kind: DeviceKind) {
  return kind === 'sub' || kind === 'fm' || kind === 'sampler' || kind === 'drum'
}

export function isEffect(kind: DeviceKind) {
  return kind === 'eq' || kind === 'comp' || kind === 'delay' || kind === 'reverb' || kind === 'chorus' || kind === 'dist' || kind === 'filter'
}

/** Audio-cable feedback. Modulation cables are allowed to read the previous sample. */
export function audioCycle(cables: Cable[]) {
  const edges = new Map<string, string[]>()
  for (const cable of cables) {
    if (cable.toPort !== 'audio' && cable.toPort !== 'audio2') continue
    const list = edges.get(cable.from) ?? []
    list.push(cable.to)
    edges.set(cable.from, list)
  }
  const color = new Map<string, number>()
  const visit = (id: string): boolean => {
    const mark = color.get(id) ?? 0
    if (mark === 1) return true
    if (mark === 2) return false
    color.set(id, 1)
    for (const next of edges.get(id) ?? []) if (visit(next)) return true
    color.set(id, 2)
    return false
  }
  for (const id of edges.keys()) if (visit(id)) return true
  return false
}

export function applyMod(base: number, amount: number, source: number, min: number, max: number) {
  const span = max - min
  const next = base + amount * span * source
  return Math.min(max, Math.max(min, next))
}

export function zoneFor(zones: SampleZone[], pitch: number) {
  const hits = zones.filter((zone) => pitch >= zone.lo && pitch <= zone.hi)
  if (!hits.length) return null
  return hits.slice().sort((a, b) => Math.abs(a.root - pitch) - Math.abs(b.root - pitch) || a.lo - b.lo)[0]
}

export interface VoiceRef {
  note: number
  age: number
  active: boolean
  released: boolean
}

/** Steal the oldest sounding voice once the polyphony limit is full. */
export function allocateVoice(voices: VoiceRef[], note: number, limit: number) {
  const cap = Math.max(1, limit)
  for (const voice of voices) if (voice.active) voice.age += 1
  const same = voices.find((voice) => voice.active && voice.note === note)
  if (same) {
    same.age = 0
    same.released = false
    return same
  }
  let slot = voices.find((voice) => !voice.active)
  if (!slot && voices.length < cap) {
    slot = { note, age: 0, active: true, released: false }
    voices.push(slot)
    return slot
  }
  if (!slot) slot = voices.slice().sort((a, b) => b.age - a.age)[0]
  slot.note = note
  slot.age = 0
  slot.active = true
  slot.released = false
  return slot
}

export function nextArp(notes: number[], step: number, mode: number, octaves: number) {
  const base = [...new Set(notes)].sort((a, b) => a - b)
  if (!base.length) return null
  const span = Math.max(1, Math.round(octaves))
  const seq: number[] = []
  for (let octave = 0; octave < span; octave++) for (const note of base) seq.push(note + octave * 12)
  const ordered = mode >= 1.5 ? [...seq, ...seq.slice(0, -1).reverse()] : mode >= 0.5 ? seq.slice().reverse() : seq
  return ordered[step % ordered.length] ?? null
}

export function cloneRack(rack: RackState): RackState {
  const ids = new Map<string, string>()
  const devices = rack.devices.map((device) => {
    const id = uid('dev')
    ids.set(device.id, id)
    return {
      ...device,
      id,
      params: { ...device.params },
      zones: device.zones.map((zone) => ({ ...zone, id: uid('zone') })),
      pads: device.pads.map((pad) => ({ ...pad })),
      pattern: [...device.pattern],
    }
  })
  const cables = rack.cables.map((cable) => ({
    ...cable,
    id: uid('cable'),
    from: ids.get(cable.from) ?? cable.from,
    to: ids.get(cable.to) ?? cable.to,
  }))
  return { devices, cables, polyphony: rack.polyphony }
}

export function normalizeProjectRack(project: Project): Project {
  project.automation = project.automation ?? []
  project.devicePresets = project.devicePresets ?? []
  project.rackPatches = project.rackPatches ?? []
  for (const track of project.tracks) normalizeTrackRack(track)
  return project
}

export function normalizeTrackRack(track: Track) {
  if (track.type !== 'midi') return
  if (!track.rack?.devices?.length) track.rack = defaultRack()
  track.rack.cables = track.rack.cables ?? []
  track.rack.polyphony = Math.min(16, Math.max(1, Math.round(track.rack.polyphony || 8)))
  for (const device of track.rack.devices) {
    device.params = { ...defaults(device.kind), ...device.params }
    device.zones = device.zones ?? []
    device.pads = device.pads?.length === 16 ? device.pads : defaultPads()
    device.pattern = device.pattern?.length === 16 ? device.pattern : Array(16).fill(0)
  }
}

export function paramAt(lanes: RackAutomation[] | undefined, deviceId: string, param: string, beat: number, fallback: number) {
  const lane = lanes?.find((item) => item.deviceId === deviceId && item.param === param)
  if (!lane?.points.length) return fallback
  const points = lane.points.slice().sort((a, b) => a.beat - b.beat)
  if (beat <= points[0].beat) return points[0].value
  const last = points[points.length - 1]
  if (beat >= last.beat) return last.value
  for (let i = 1; i < points.length; i++) {
    if (beat <= points[i].beat) {
      const a = points[i - 1]
      const b = points[i]
      const span = b.beat - a.beat || 1
      return a.value + ((beat - a.beat) / span) * (b.value - a.value)
    }
  }
  return fallback
}
