import { latencyOf } from './catalog'
import { sanitize } from './dsp'
import { sampleAlpha } from '../core/smooth'
import type { BlockContext, Processor } from './types'

export interface SlotNote {
  offset: number
  pitch: number
  vel: number
}

export interface ChainSlot {
  id: string
  pluginId: string
  enabled: boolean
  wet: number
  params: Record<string, number>
  failed: boolean
  sidechain: string
  processor: Processor | null
  /** Note events for this block, in sample offsets. Cleared after the slot renders. */
  notes?: SlotNote[]
}

/** Long enough for tune and look-ahead at 48 kHz and 96 kHz. */
const DELAY_MAX = 8192

interface DelayState {
  id: string
  mix: number
  ready: boolean
  pos: number
  lines: Float32Array[]
}

/** Preallocated ping-pong buffers. `processChain` allocates nothing when this fits the block. */
export interface ChainPool {
  frames: number
  channels: number
  maxSlots: number
  stages: Float32Array[][]
  wet: Float32Array[][]
  side: BlockContext
  delay: DelayState[]
  views: Map<number, { stages: Float32Array[][]; wet: Float32Array[][] }>
}

const looseDelay = new WeakMap<ChainSlot, DelayState>()
const looseMix = new WeakMap<ChainSlot, number>()

export function prepareChainPool(maxSlots: number, channels: number, frames: number): ChainPool {
  const slots = Math.max(1, maxSlots | 0)
  const ch = Math.max(1, channels | 0)
  const n = Math.max(1, frames | 0)
  const stages: Float32Array[][] = []
  for (let s = 0; s <= slots; s++) stages.push(Array.from({ length: ch }, () => new Float32Array(n)))
  const wet: Float32Array[][] = []
  for (let s = 0; s < slots; s++) wet.push(Array.from({ length: ch }, () => new Float32Array(n)))
  const delay: DelayState[] = []
  for (let s = 0; s < slots; s++) {
    delay.push({
      id: '',
      mix: 0,
      ready: false,
      pos: 0,
      lines: Array.from({ length: ch }, () => new Float32Array(DELAY_MAX)),
    })
  }
  const pool: ChainPool = {
    frames: n,
    channels: ch,
    maxSlots: slots,
    stages,
    wet,
    side: {
      sampleRate: 48000,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    },
    delay,
    views: new Map(),
  }
  pool.views.set(n, { stages, wet })
  return pool
}

/** Build block-size views before the render loop so a known quantum does not allocate. */
export function preseedChain(pool: ChainPool, sizes: readonly number[]) {
  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i] | 0
    if (n > 0 && n <= pool.frames) viewFor(pool, n)
  }
}

export function processChain(
  slots: ChainSlot[],
  input: Float32Array[],
  output: Float32Array[],
  ctx: BlockContext,
  sidechainAt?: (id: string, length: number) => Float32Array | null,
  pool?: ChainPool,
  count?: number,
) {
  const nSlots = count ?? slots.length
  const n = input[0]?.length ?? output[0]?.length ?? 0
  const channels = output.length
  const pooled = !!(pool && n > 0 && n <= pool.frames && pool.channels >= Math.max(1, channels) && pool.maxSlots >= nSlots)
  const view = pooled && pool ? viewFor(pool, n) : null
  let current = pooled && view ? view.stages[0] : input.map((channel) => Float32Array.from(channel ?? new Float32Array(n)))
  if (!current.length) current = [new Float32Array(n)]
  if (pooled) copyInto(input, current, n, channels)
  else while (current.length < channels) current.push(Float32Array.from(current[0]))
  let latency = 0
  const started = now()
  for (let s = 0; s < nSlots; s++) {
    const slot = slots[s]
    const next = pooled && view ? view.stages[s + 1] : current.map(() => new Float32Array(n))
    const active = slot.enabled && !slot.failed && slot.processor && slot.wet > 0.0001
    if (!active || !slot.processor) {
      if (slot.notes) slot.notes.length = 0
      rememberClosed(pool, slot, s)
      copy(current, next)
    } else {
      try {
        const wet = pooled && view ? view.wet[s] : next.map(() => new Float32Array(n))
        const sidechain = slot.sidechain && sidechainAt ? sidechainAt(slot.sidechain, n) : null
        const block = sidechain ? fillSide(pooled && pool ? pool.side : { ...ctx, sidechain }, ctx, sidechain) : ctx
        renderSlot(slot, current, wet, n, block)
        mixChainSlot(slot, s, current, wet, next, channels, n, ctx.sampleRate, pool)
        latency += slot.processor.latencySamples || latencyOf(slot.pluginId, slot.params, ctx.sampleRate, true)
      } catch {
        slot.failed = true
        if (slot.notes) slot.notes.length = 0
        copy(current, next)
      }
    }
    current = next
  }
  for (let c = 0; c < channels; c++) {
    output[c].set(current[c] ?? current[0])
  }
  return { latency, cpu: now() - started }
}

function renderSlot(slot: ChainSlot, input: Float32Array[], output: Float32Array[], frames: number, ctx: BlockContext) {
  const proc = slot.processor
  if (!proc) return
  const notes = slot.notes
  const play = proc as Processor & { note?: (pitch: number, vel: number) => void }
  if (!notes?.length || !play.note) {
    proc.process(input, output, slot.params, ctx)
    if (notes) notes.length = 0
    return
  }
  notes.sort(byOffset)
  let cursor = 0
  let index = 0
  const saved = ctx.sampleTime
  while (cursor < frames) {
    while (index < notes.length && notes[index].offset <= cursor) {
      const event = notes[index]
      const velocity = event.vel <= 0 ? 0 : Math.max(0, Math.min(1, event.vel))
      play.note(event.pitch, velocity)
      index += 1
    }
    const end = index < notes.length ? Math.min(frames, Math.max(cursor + 1, notes[index].offset)) : frames
    if (end > cursor) {
      ctx.sampleTime = saved + cursor
      proc.process(sliceOf(input, cursor, end), sliceOf(output, cursor, end), slot.params, ctx)
    }
    cursor = end
  }
  ctx.sampleTime = saved
  notes.length = 0
}

function byOffset(a: SlotNote, b: SlotNote) {
  return a.offset - b.offset
}

function sliceOf(buffers: Float32Array[], start: number, end: number) {
  const out: Float32Array[] = new Array(buffers.length)
  for (let c = 0; c < buffers.length; c++) out[c] = buffers[c].subarray(start, end)
  return out
}

export function mixChainSlot(
  slot: ChainSlot,
  index: number,
  dry: Float32Array[],
  wet: Float32Array[],
  next: Float32Array[],
  channels: number,
  frames: number,
  sampleRate: number,
  pool?: ChainPool,
) {
  const mix = Math.min(1, Math.max(0, slot.wet))
  const reported = Math.max(0, slot.processor?.latencySamples || 0)
  const delaySamples = reported > 0 && mix < 0.9995 ? Math.min(reported, DELAY_MAX) : 0
  const prepared = pool && index >= 0 && index < pool.delay.length ? pool.delay[index] : null
  if (prepared && prepared.id !== slot.id) {
    resetDelay(prepared)
    prepared.id = slot.id
  }
  if (prepared && !prepared.ready) {
    prepared.mix = mix
    prepared.ready = true
  }
  const held = prepared?.ready ? prepared.mix : (looseMix.get(slot) ?? mix)
  const steady = Math.abs(held - mix) < 1e-8
  if (delaySamples <= 0 && steady) {
    if (prepared) prepared.mix = mix
    else looseMix.set(slot, mix)
    mixConstant(dry, wet, next, channels, frames, mix)
    return
  }
  const state = prepared ?? looseState(slot, channels)
  if (!prepared) {
    if (state.id !== slot.id) {
      resetDelay(state)
      state.id = slot.id
    }
    if (!state.ready) {
      state.mix = looseMix.get(slot) ?? mix
      state.ready = true
    }
  }
  const alpha = sampleAlpha(sampleRate)
  let current = state.mix
  let pos = state.pos
  for (let i = 0; i < frames; i++) {
    if (!steady) {
      current += (mix - current) * alpha
      if (Math.abs(current - mix) < 1e-6) current = mix
    }
    const dryMix = 1 - current
    for (let c = 0; c < channels; c++) {
      const drySample = dry[c]?.[i] ?? 0
      let delayed = drySample
      if (delaySamples > 0) {
        const line = state.lines[c]
        const read = (pos - delaySamples + DELAY_MAX) % DELAY_MAX
        delayed = line?.[read] ?? 0
        if (line) line[pos] = drySample
      }
      const processed = wet[c]?.[i] ?? drySample
      next[c][i] = sanitize(delayed * dryMix + processed * current)
    }
    if (delaySamples > 0) pos = (pos + 1) % DELAY_MAX
  }
  state.mix = current
  state.pos = pos
  if (prepared) prepared.mix = current
  looseMix.set(slot, current)
}

function mixConstant(
  dry: Float32Array[],
  wet: Float32Array[],
  next: Float32Array[],
  channels: number,
  frames: number,
  mix: number,
) {
  const dryMix = 1 - mix
  for (let c = 0; c < channels; c++) {
    const dryCh = dry[c]
    const wetCh = wet[c]
    const dest = next[c]
    for (let i = 0; i < frames; i++) {
      const sample = dryCh?.[i] ?? 0
      const processed = wetCh?.[i] ?? sample
      dest[i] = sanitize(sample * dryMix + processed * mix)
    }
  }
}

function rememberClosed(pool: ChainPool | undefined, slot: ChainSlot, index: number) {
  const prepared = pool && index >= 0 && index < pool.delay.length ? pool.delay[index] : null
  if (!prepared) {
    looseMix.set(slot, 0)
    return
  }
  if (prepared.id !== slot.id) {
    resetDelay(prepared)
    prepared.id = slot.id
  }
  prepared.mix = 0
  prepared.ready = true
}

function looseState(slot: ChainSlot, channels: number) {
  let loose = looseDelay.get(slot)
  if (!loose) {
    loose = {
      id: slot.id,
      mix: 0,
      ready: false,
      pos: 0,
      lines: Array.from({ length: Math.max(1, channels) }, () => new Float32Array(DELAY_MAX)),
    }
    looseDelay.set(slot, loose)
  }
  return loose
}

function resetDelay(state: DelayState) {
  state.ready = false
  state.mix = 0
  state.pos = 0
  for (let c = 0; c < state.lines.length; c++) state.lines[c].fill(0)
}

function viewFor(pool: ChainPool, frames: number) {
  const hit = pool.views.get(frames)
  if (hit) return hit
  const stages = pool.stages.map((row) => row.map((buffer) => buffer.subarray(0, frames)))
  const wet = pool.wet.map((row) => row.map((buffer) => buffer.subarray(0, frames)))
  const view = { stages, wet }
  pool.views.set(frames, view)
  return view
}

function fillSide(target: BlockContext, ctx: BlockContext, sidechain: Float32Array) {
  target.sampleRate = ctx.sampleRate
  target.tempo = ctx.tempo
  target.sampleTime = ctx.sampleTime
  target.sidechain = sidechain
  target.scaleRoot = ctx.scaleRoot
  target.scaleIntervals = ctx.scaleIntervals
  target.scaleCents = ctx.scaleCents
  target.quality = ctx.quality
  target.offline = ctx.offline
  target.playTime = ctx.playTime
  return target
}

function copyInto(from: Float32Array[], to: Float32Array[], frames: number, channels: number) {
  const sourceCount = Math.max(1, from.length)
  for (let c = 0; c < channels; c++) {
    const src = from[Math.min(c, sourceCount - 1)]
    const dest = to[c]
    if (!dest) continue
    if (!src) {
      for (let i = 0; i < frames; i++) dest[i] = 0
      continue
    }
    const n = Math.min(frames, src.length)
    for (let i = 0; i < n; i++) dest[i] = src[i]
    for (let i = n; i < frames; i++) dest[i] = 0
  }
}

function copy(from: Float32Array[], to: Float32Array[]) {
  for (let c = 0; c < to.length; c++) {
    const src = from[Math.min(c, from.length - 1)]
    if (src) to[c].set(src)
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
