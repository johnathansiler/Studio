/** Loom: local multisample and layered instrument. No network calls. */

export type Mic = 'close' | 'room' | 'far'
export type Trigger = 'attack' | 'release' | 'legato'
export type LayerKind = 'sample' | 'analog' | 'wave' | 'fm' | 'grain' | 'physical'
export type ModSource = 'lfo' | 'env' | 'vel' | 'cc1' | 'note'
export type ModDest = 'cutoff' | 'pitch' | 'level' | 'pan'

export interface Zone {
  id: string
  articulation: string
  lovel: number
  hivel: number
  lokey: number
  hikey: number
  root: number
  sampleId: string
  start: number
  mic: Mic
  rr: number
  trigger: Trigger
  dynamic: number
  interval: number | null
}

export interface Articulation {
  id: string
  name: string
  keyswitch: number | null
}

export interface LoomInstrument {
  id: string
  name: string
  articulations: Articulation[]
  zones: Zone[]
  rrMode: 'cycle' | 'random'
  keyLow: number
  keyHigh: number
  script: string
}

export interface Layer {
  kind: LayerKind
  level: number
  pan: number
  cutoff: number
  attack: number
  decay: number
  sustain: number
  release: number
  lfoRate: number
  lfoDepth: number
  grain: number
}

export interface ModRoute {
  source: ModSource
  dest: ModDest
  amount: number
}

export interface Patch {
  id: string
  name: string
  layers: Layer[]
  routes: ModRoute[]
  macros: [number, number, number, number]
}

export interface LoomSlot {
  instrumentId: string
  /** Patch for this split. Empty uses the performance patch. */
  patchId?: string
  channel: number
  low: number
  high: number
  output: number
}

export interface LoomState {
  instruments: LoomInstrument[]
  slots: LoomSlot[]
  patches: Patch[]
  active: string
  patchId: string
  articulation: string
  cc1: number
  mics: Record<Mic, number>
  lite: boolean
  rr: number
  seed: number
  xy: { x: number; y: number }
  deep: boolean
}

export interface ZoneHit {
  zone: Zone
  gain: number
  rate: number
}

export interface PickInput {
  note: number
  vel: number
  articulation: string
  cc1: number
  rr: number
  trigger: Trigger
  lite: boolean
  seed: number
  interval: number | null
  mics?: Partial<Record<Mic, number>>
}

const MICS: Mic[] = ['close', 'room', 'far']

export function starterInstrument(): LoomInstrument {
  const articulations: Articulation[] = [
    { id: 'sustain', name: 'Sustain', keyswitch: 24 },
    { id: 'staccato', name: 'Staccato', keyswitch: 25 },
    { id: 'pizz', name: 'Pizz', keyswitch: 26 },
    { id: 'tremolo', name: 'Tremolo', keyswitch: 27 },
  ]
  const zones: Zone[] = []
  for (const art of articulations) {
    for (const mic of MICS) {
      for (const dynamic of [0, 1]) {
        for (const rr of [0, 1]) {
          for (const layer of [
            { lovel: 1, hivel: 80 },
            { lovel: 81, hivel: 127 },
          ]) {
            zones.push({
              id: `${art.id}-${mic}-d${dynamic}-r${rr}-v${layer.lovel}`,
              articulation: art.id,
              lovel: layer.lovel,
              hivel: layer.hivel,
              lokey: 36,
              hikey: 84,
              root: 60,
              sampleId: `${art.id}-${mic}-d${dynamic}-r${rr}-v${layer.lovel}`,
              start: dynamic ? 0.02 : 0,
              mic,
              rr,
              trigger: 'attack',
              dynamic,
              interval: null,
            })
          }
        }
      }
    }
    zones.push({
      id: `${art.id}-rel`,
      articulation: art.id,
      lovel: 1,
      hivel: 127,
      lokey: 36,
      hikey: 84,
      root: 60,
      sampleId: `${art.id}-rel`,
      start: 0,
      mic: 'close',
      rr: 0,
      trigger: 'release',
      dynamic: 0,
      interval: null,
    })
  }
  zones.push({
    id: 'legato-2',
    articulation: 'sustain',
    lovel: 1,
    hivel: 127,
    lokey: 36,
    hikey: 84,
    root: 60,
    sampleId: 'legato-2',
    start: 0,
    mic: 'close',
    rr: 0,
    trigger: 'legato',
    dynamic: 0,
    interval: 2,
  })
  return {
    id: 'soft-ensemble',
    name: 'Soft Ensemble',
    articulations,
    zones,
    rrMode: 'cycle',
    keyLow: 24,
    keyHigh: 27,
    script: 'humanize(6)\nstrum(18)',
  }
}

export function starterPatch(): Patch {
  return {
    id: 'ensemble-pad',
    name: 'Ensemble Pad',
    macros: [0.4, 0.55, 0.3, 0.2],
    routes: [
      { source: 'lfo', dest: 'cutoff', amount: 0.25 },
      { source: 'vel', dest: 'level', amount: 0.4 },
    ],
    layers: [
      layer('sample', 0.8),
      layer('analog', 0.35),
    ],
  }
}

export function starterLoom(): LoomState {
  const instrument = starterInstrument()
  const reed = { ...starterInstrument(), id: 'reed', name: 'Reed', script: 'legato()' }
  const patch = starterPatch()
  const reedPatch: Patch = {
    id: 'reed-air',
    name: 'Reed Air',
    macros: [0.62, 0.4, 0.5, 0.25],
    routes: [{ source: 'cc1', dest: 'cutoff', amount: 0.35 }],
    layers: [layer('wave', 0.7), layer('fm', 0.28)],
  }
  return {
    instruments: [instrument, reed],
    patches: [patch, reedPatch],
    slots: [
      { instrumentId: instrument.id, patchId: patch.id, channel: 0, low: 0, high: 127, output: 0 },
      { instrumentId: reed.id, patchId: reedPatch.id, channel: 2, low: 0, high: 127, output: 1 },
    ],
    active: instrument.id,
    patchId: patch.id,
    articulation: 'sustain',
    cc1: 0.35,
    mics: { close: 0.8, room: 0.35, far: 0.15 },
    lite: false,
    rr: 0,
    seed: 1,
    xy: { x: 0.5, y: 0.5 },
    deep: false,
  }
}

export function activeInstrument(state: LoomState) {
  return state.instruments.find((item) => item.id === state.active) ?? state.instruments[0]
}

export function articulationForNote(instrument: LoomInstrument, note: number) {
  if (note < instrument.keyLow || note > instrument.keyHigh) return null
  return instrument.articulations.find((item) => item.keyswitch === note)?.id ?? null
}

export function slotFor(slots: LoomSlot[], channel: number, note: number) {
  return slots.find((slot) => (slot.channel === 0 || slot.channel === channel) && note >= slot.low && note <= slot.high) ?? null
}

/** Pick the instrument and patch a note should play. Channel 0 matches omni slots. */
export function voiceState(state: LoomState, channel: number, pitch: number): LoomState {
  const slot = slotFor(state.slots, channel, pitch)
  if (!slot) return state
  return { ...state, active: slot.instrumentId, patchId: slot.patchId || state.patchId }
}

export function advanceNote(state: LoomState, pitch: number) {
  const instrument = activeInstrument(state)
  const key = instrument ? articulationForNote(instrument, pitch) : null
  if (key) return { sound: false, articulation: key, rr: state.rr }
  return { sound: true, articulation: state.articulation, rr: state.rr + 1 }
}

/** Map a 0–127 controller across the articulation list. */
export function articulationForCC(instrument: LoomInstrument, value: number) {
  const count = instrument.articulations.length
  if (!count) return ''
  const index = Math.min(count - 1, Math.floor((clamp(value, 0, 127) / 128) * count))
  return instrument.articulations[index].id
}

/** Choose the samples that should speak for one note. Keyswitches return no hits. */
export function pickZones(instrument: LoomInstrument, input: PickInput): { hits: ZoneHit[]; keyswitch: string | null } {
  const keyswitch = articulationForNote(instrument, input.note)
  if (keyswitch) return { hits: [], keyswitch }
  const midiVel = clamp(Math.round(input.vel * 127), 1, 127)
  let pool = instrument.zones.filter((zone) => zone.articulation === input.articulation && zone.lokey <= input.note && zone.hikey >= input.note && zone.lovel <= midiVel && zone.hivel >= midiVel)
  const wanted = input.trigger === 'legato' ? pool.filter((zone) => zone.trigger === 'legato' && (zone.interval == null || zone.interval === input.interval)) : pool.filter((zone) => zone.trigger === input.trigger)
  pool = wanted.length ? wanted : input.trigger === 'legato' ? pool.filter((zone) => zone.trigger === 'attack') : []
  if (input.lite) {
    const close = pool.filter((zone) => zone.mic === 'close' && zone.rr === 0)
    if (close.length) pool = close
  }
  const groups = new Map<string, Zone[]>()
  for (const zone of pool) {
    const key = `${zone.mic}|${zone.dynamic}|${zone.lovel}|${zone.trigger}`
    const list = groups.get(key) ?? []
    list.push(zone)
    groups.set(key, list)
  }
  const rng = mulberry32(input.seed + input.rr * 17 + input.note)
  const hits: ZoneHit[] = []
  for (const group of groups.values()) {
    const chosen = chooseRoundRobin(group, instrument.rrMode, input.rr, rng)
    if (!chosen) continue
    const fade = input.lite ? (chosen.dynamic === nearestDynamic(pool, input.cc1) ? 1 : 0) : dynamicGain(chosen.dynamic, input.cc1)
    const mic = input.lite && chosen.mic !== 'close' ? 0 : (input.mics?.[chosen.mic] ?? 1)
    const gain = fade * mic
    if (gain <= 0.001) continue
    hits.push({ zone: chosen, gain, rate: 2 ** ((input.note - chosen.root) / 12) })
  }
  return { hits, keyswitch: null }
}

export function memoryBudget(form: 'phone' | 'fold' | 'desk') {
  if (form === 'phone') return 12 * 1024 * 1024
  if (form === 'fold') return 32 * 1024 * 1024
  return 96 * 1024 * 1024
}

/** Preload the active articulation only, and stay inside the byte budget. */
export function planStream(zones: Zone[], articulation: string, lite: boolean, budget: number, sizeOf: (id: string) => number) {
  const head = 4096 * 4
  let bytes = 0
  const keep: string[] = []
  const seen = new Set<string>()
  for (const zone of zones) {
    if (zone.articulation !== articulation) continue
    if (lite && (zone.mic !== 'close' || zone.rr !== 0)) continue
    if (seen.has(zone.sampleId)) continue
    const full = Math.max(0, sizeOf(zone.sampleId))
    const take = Math.min(full, head)
    const use = bytes + full <= budget ? full : take
    if (!use || bytes + use > budget) continue
    bytes += use
    seen.add(zone.sampleId)
    keep.push(zone.sampleId)
  }
  return { keep, bytes }
}

export interface ScriptApi {
  detune: number
  strum: number
  legato: boolean
  cc: { controller: number; value: number }[]
}

export interface CompiledScript {
  steps: ScriptStep[]
}

type ScriptStep =
  | { op: 'humanize'; amount: number }
  | { op: 'strum'; amount: number }
  | { op: 'legato' }
  | { op: 'cc'; controller: number; value: number }
  | { op: 'if'; left: 'vel' | 'note'; cmp: '>' | '<'; right: number; then: ScriptStep }

const CALLS = new Set(['humanize', 'strum', 'legato', 'cc'])

/** Parse a Loom script. Anything outside the call subset is rejected, so it cannot reach the page. */
export function compileScript(source: string): { script: CompiledScript | null; error: string | null } {
  if (/[\[\]{}]|\.[A-Za-z_]|constructor|global|fetch|import|function|=>|while|new |eval|process|window|\bself\b/i.test(source)) {
    return { script: null, error: 'blocked' }
  }
  const steps: ScriptStep[] = []
  for (const raw of source.split(/[\n;]/)) {
    const line = raw.trim()
    if (!line) continue
    const gated = line.match(/^if\s*\(\s*(vel|note)\s*([<>])\s*(-?\d+(?:\.\d+)?)\s*\)\s*(.+)$/)
    if (gated) {
      const then = parseCall(gated[4])
      if (!then) return { script: null, error: 'blocked' }
      steps.push({ op: 'if', left: gated[1] as 'vel' | 'note', cmp: gated[2] as '>' | '<', right: Number(gated[3]), then })
      continue
    }
    const step = parseCall(line)
    if (!step) return { script: null, error: 'blocked' }
    steps.push(step)
  }
  return { script: { steps }, error: null }
}

export function runScript(script: CompiledScript, api: ScriptApi, env: { vel: number; note: number }) {
  for (const step of script.steps) {
    if (step.op === 'if') {
      const value = step.left === 'vel' ? env.vel : env.note
      const pass = step.cmp === '>' ? value > step.right : value < step.right
      if (pass) applyStep(step.then, api)
      continue
    }
    applyStep(step, api)
  }
}

export function resolveLayer(layer: Layer, routes: ModRoute[], mods: Record<ModSource, number>): Layer {
  const next = { ...layer }
  for (const route of routes) {
    const delta = route.amount * mods[route.source]
    if (route.dest === 'cutoff') next.cutoff = clamp(next.cutoff + delta, 0, 1)
    if (route.dest === 'level') next.level = clamp(next.level + delta, 0, 1)
    if (route.dest === 'pan') next.pan = clamp(next.pan + delta, -1, 1)
    if (route.dest === 'pitch') next.grain = clamp(next.grain + delta, 0, 1)
  }
  return next
}

export function mutatePatch(patch: Patch, seed: number, amount = 0.15): Patch {
  const rng = mulberry32(seed)
  const nudge = (value: number, span = 1) => clamp(value + (rng() * 2 - 1) * amount * span, 0, span === 1 ? 1 : span)
  return {
    ...patch,
    id: `${patch.id}-m${seed}`,
    name: `${patch.name} spin`,
    macros: patch.macros.map((value) => nudge(value)) as Patch['macros'],
    layers: patch.layers.map((item) => ({ ...item, level: nudge(item.level), cutoff: nudge(item.cutoff) })),
  }
}

export function blendPatches(a: Patch, b: Patch, mix: number): Patch {
  const t = clamp(mix, 0, 1)
  const count = Math.max(a.layers.length, b.layers.length)
  const layers: Layer[] = []
  for (let i = 0; i < Math.min(4, count); i++) {
    const left = a.layers[i] ?? a.layers[0]
    const right = b.layers[i] ?? b.layers[0]
    if (!left || !right) continue
    layers.push({
      ...left,
      level: lerp(left.level, right.level, t),
      pan: lerp(left.pan, right.pan, t),
      cutoff: lerp(left.cutoff, right.cutoff, t),
      attack: lerp(left.attack, right.attack, t),
      grain: lerp(left.grain, right.grain, t),
    })
  }
  return {
    id: `${a.id}-blend`,
    name: `${a.name} / ${b.name}`,
    routes: a.routes,
    macros: a.macros.map((value, index) => lerp(value, b.macros[index] ?? value, t)) as Patch['macros'],
    layers,
  }
}

export function applyOrb(patch: Patch, x: number, y: number): Patch {
  const nx = clamp(x, 0, 1)
  const ny = clamp(y, 0, 1)
  return {
    ...patch,
    macros: [nx, ny, clamp(patch.macros[2] + (nx - 0.5) * 0.4, 0, 1), clamp(patch.macros[3] + (ny - 0.5) * 0.4, 0, 1)],
    layers: patch.layers.map((layer) => ({
      ...layer,
      cutoff: clamp(layer.cutoff * (0.45 + nx), 0, 1),
      level: clamp(layer.level * (0.55 + 0.45 * ny), 0, 1),
    })),
  }
}

export function arpNotes(notes: number[], steps: number, mode: 'up' | 'down' | 'upDown') {
  const ordered = [...notes].sort((a, b) => a - b)
  if (!ordered.length || steps <= 0) return []
  const down = [...ordered].reverse()
  const cycle = mode === 'down' ? down : mode === 'upDown' ? [...ordered, ...down.slice(1, -1)] : ordered
  return Array.from({ length: steps }, (_, index) => cycle[index % cycle.length])
}

export function renderLayer(kind: LayerKind, frames: number, sr: number, freq: number, seed: number) {
  const out = new Float32Array(frames)
  const rng = mulberry32(seed)
  let low = 0
  let burst = 0
  const delay = new Float32Array(Math.max(8, Math.round(sr / Math.max(40, freq))))
  let write = 0
  for (let i = 0; i < frames; i++) {
    const t = i / sr
    const phase = (freq * t) % 1
    let sample = 0
    if (kind === 'analog' || kind === 'sample') sample = phase < 0.5 ? 0.6 : -0.6
    else if (kind === 'wave') sample = Math.sin(2 * Math.PI * phase) * 0.5 + Math.sin(2 * Math.PI * phase * 2) * 0.2
    else if (kind === 'fm') sample = Math.sin(2 * Math.PI * phase + Math.sin(2 * Math.PI * phase * 2) * 1.4) * 0.45
    else if (kind === 'grain') sample = (rng() * 2 - 1) * Math.sin(Math.PI * ((i % 128) / 128)) * 0.4
    else {
      const noise = i < 64 ? rng() * 2 - 1 : 0
      const tap = delay[write] || 0
      burst = 0.996 * tap + noise * 0.2
      delay[write] = burst
      write = (write + 1) % delay.length
      sample = burst * 0.8
    }
    low += (sample - low) * 0.2
    out[i] = low
  }
  return out
}

export function renderNote(state: LoomState, pitch: number, vel: number, sr: number, frames: number, interval: number | null = null) {
  const patch = state.patches.find((item) => item.id === state.patchId) ?? state.patches[0]
  const instrument = activeInstrument(state)
  const picked = instrument
    ? pickZones(instrument, {
        note: pitch,
        vel,
        articulation: state.articulation,
        cc1: state.cc1,
        rr: state.rr,
        trigger: interval ? 'legato' : 'attack',
        lite: state.lite,
        seed: state.seed,
        interval,
        mics: state.mics,
      })
    : { hits: [], keyswitch: null }
  const out = new Float32Array(frames)
  if (picked.keyswitch || !patch) return out
  let detune = 0
  let strum = 0
  if (instrument) {
    const compiled = compileScript(instrument.script)
    if (compiled.script) {
      const api: ScriptApi = { detune: 0, strum: 0, legato: false, cc: [] }
      runScript(compiled.script, api, { vel, note: pitch })
      detune = api.detune
      strum = api.strum
    }
  }
  const morphed = applyOrb(patch, state.xy.x, state.xy.y)
  const mods = { lfo: 0.5, env: 1, vel, cc1: state.cc1, note: pitch / 127 }
  const freq = 440 * 2 ** ((pitch - 69) / 12 + detune / 1200)
  const start = picked.hits.length ? Math.min(...picked.hits.map((hit) => hit.zone.start)) : 0
  const delay = Math.min(Math.floor(frames * 0.25), Math.max(0, Math.round(start * sr) + Math.round((strum / 1000) * sr)))
  const zoneGain = picked.hits.length ? Math.max(...picked.hits.map((hit) => hit.gain)) : 1
  morphed.layers.slice(0, 4).forEach((item, index) => {
    const resolved = resolveLayer(item, morphed.routes, mods)
    const tone = renderLayer(resolved.kind, frames, sr, freq, state.seed + index)
    const gain = resolved.level * (0.35 + vel * 0.65) * zoneGain * (index % 2 === 0 ? 0.7 : 0.3)
    for (let i = delay; i < frames; i++) out[i] += tone[i - delay] * gain
  })
  return out
}

function layer(kind: LayerKind, level: number): Layer {
  return { kind, level, pan: 0, cutoff: 0.7, attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.3, lfoRate: 0.2, lfoDepth: 0.15, grain: 0.4 }
}

function chooseRoundRobin(group: Zone[], mode: 'cycle' | 'random', rr: number, rng: () => number) {
  const indexes = [...new Set(group.map((zone) => zone.rr))].sort((a, b) => a - b)
  if (!indexes.length) return null
  const pick = mode === 'random' ? indexes[Math.min(indexes.length - 1, Math.floor(rng() * indexes.length))] : indexes[rr % indexes.length]
  return group.find((zone) => zone.rr === pick) ?? group[0]
}

function nearestDynamic(pool: Zone[], cc1: number) {
  return pool.reduce((best, zone) => (Math.abs(zone.dynamic - cc1) < Math.abs(best - cc1) ? zone.dynamic : best), pool[0]?.dynamic ?? 0)
}

function dynamicGain(dynamic: number, cc1: number) {
  const dist = Math.abs(dynamic - clamp(cc1, 0, 1))
  return dist >= 1 ? 0 : 1 - dist
}

function parseCall(line: string): ScriptStep | null {
  const match = line.trim().match(/^([A-Za-z]+)\s*\(\s*([^)]*)\s*\)$/)
  if (!match || !CALLS.has(match[1])) return null
  const args = match[2].trim() ? match[2].split(',').map((part) => part.trim()) : []
  if (args.some((arg) => !/^-?\d+(?:\.\d+)?$/.test(arg))) return null
  const nums = args.map(Number)
  if (match[1] === 'humanize' && nums.length === 1) return { op: 'humanize', amount: nums[0] }
  if (match[1] === 'strum' && nums.length === 1) return { op: 'strum', amount: nums[0] }
  if (match[1] === 'legato' && nums.length === 0) return { op: 'legato' }
  if (match[1] === 'cc' && nums.length === 2) return { op: 'cc', controller: nums[0], value: nums[1] }
  return null
}

function applyStep(step: ScriptStep, api: ScriptApi) {
  if (step.op === 'humanize') api.detune = step.amount
  if (step.op === 'strum') api.strum = step.amount
  if (step.op === 'legato') api.legato = true
  if (step.op === 'cc') api.cc.push({ controller: step.controller, value: step.value })
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
