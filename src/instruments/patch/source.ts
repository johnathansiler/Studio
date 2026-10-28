import type { LayerKind } from './types'

/**
 * One sound inside a layered patch.
 * The patch calls noteOn / noteOff and mixes render().
 * connect() places the source on a Web Audio graph when it is used on its own.
 * A later sample engine can implement this same surface.
 */
export interface LayerSource {
  readonly kind: LayerKind
  noteOn(note: number, velocity: number, time?: number): void
  noteOff(note: number, time?: number): void
  connect(destination: AudioNode): void
  disconnect(): void
  setParam(id: string, value: number): void
  setBuffer?(channel: Float32Array | null): void
  render(frames: number): Float32Array
  tick?(): number
  dispose(): void
}

interface TimedNote {
  note: number
  velocity: number
  off: boolean
  at: number
}

/** Honors the optional note time (AudioContext seconds) at sample resolution. */
export class NoteClock {
  seconds = 0
  private pending: TimedNote[] = []

  noteOn(note: number, velocity: number, time: number | undefined, now: (note: number, velocity: number) => void) {
    if (typeof time === 'number' && Number.isFinite(time) && time > this.seconds + 1e-4) {
      this.pending.push({ note, velocity, off: false, at: time })
      this.pending.sort((a, b) => a.at - b.at)
      return
    }
    now(note, velocity)
  }

  noteOff(note: number, time: number | undefined, now: (note: number) => void) {
    if (typeof time === 'number' && Number.isFinite(time) && time > this.seconds + 1e-4) {
      this.pending.push({ note, velocity: 0, off: true, at: time })
      this.pending.sort((a, b) => a.at - b.at)
      return
    }
    now(note)
  }

  advance(frames: number, sampleRate: number, on: (note: number, velocity: number) => void, off: (note: number) => void) {
    const end = this.seconds + frames / sampleRate
    while (this.pending.length && this.pending[0].at <= end) {
      const item = this.pending.shift()!
      if (item.off) off(item.note)
      else on(item.note, item.velocity)
    }
    this.seconds = end
  }
}

export interface OutputLink {
  node: ScriptProcessorNode | null
  destination: AudioNode | null
}

const links = new WeakMap<object, AudioNode | null>()

export function connectedDestination(source: object) {
  return links.get(source) ?? null
}

export function emptyLink(): OutputLink {
  return { node: null, destination: null }
}

export function bindMono(owner: object, render: (frames: number) => Float32Array, destination: AudioNode, link: OutputLink) {
  bindChannels(owner, destination, link, 1, (event) => {
    const audio = render(event.outputBuffer.length)
    const data = event.outputBuffer.getChannelData(0)
    data.set(audio.subarray(0, data.length))
  })
}

export function bindStereo(
  owner: object,
  render: (frames: number) => { left: Float32Array; right: Float32Array },
  destination: AudioNode,
  link: OutputLink,
) {
  bindChannels(owner, destination, link, 2, (event) => {
    const audio = render(event.outputBuffer.length)
    const left = event.outputBuffer.getChannelData(0)
    left.set(audio.left.subarray(0, left.length))
    if (event.outputBuffer.numberOfChannels > 1) {
      const right = event.outputBuffer.getChannelData(1)
      right.set(audio.right.subarray(0, right.length))
    }
  })
}

function bindChannels(
  owner: object,
  destination: AudioNode,
  link: OutputLink,
  channels: number,
  fill: (event: AudioProcessingEvent) => void,
) {
  link.destination = destination
  links.set(owner, destination)
  const ctx = destination?.context as AudioContext | undefined
  if (!ctx || typeof ctx.createScriptProcessor !== 'function') return
  try { link.node?.disconnect() } catch { /* already disconnected */ }
  try {
    const node = ctx.createScriptProcessor(256, 0, channels)
    node.onaudioprocess = (event) => fill(event)
    node.connect(destination)
    link.node = node
  } catch {
    link.node = null
  }
}

export function markConnected(owner: object, destination: AudioNode | null) {
  links.set(owner, destination)
}

export function releaseOutput(owner: object, link: OutputLink) {
  try { link.node?.disconnect() } catch { /* already disconnected */ }
  link.node = null
  link.destination = null
  links.set(owner, null)
}
