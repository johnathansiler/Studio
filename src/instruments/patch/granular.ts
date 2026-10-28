import { clamp, hashUnit, hermite, san } from './dsp'
import type { LayerKind } from './types'
import { NoteClock, bindMono, emptyLink, releaseOutput, type LayerSource, type OutputLink } from './source'

interface Grain {
  cursor: number
  age: number
  length: number
  rate: number
  on: boolean
}

interface Stream {
  note: number
  velocity: number
  released: boolean
  env: number
  spawn: number
  grains: Grain[]
}

/**
 * Overlap-add granular reader.
 * Hann windows and Hermite interpolation keep grains click-free when pitch moves.
 * Freeze holds the scan; spray only jitters where a grain starts.
 */
export class GranularSource implements LayerSource {
  readonly kind: LayerKind = 'granular'
  private readonly clock = new NoteClock()
  private readonly link: OutputLink = emptyLink()
  private buffer: Float32Array | null = null
  private streams: Stream[] = []
  private head = 0.35
  private position = 0.35
  private size = 90
  private density = 18
  private spray = 0.12
  private pitch = 0
  private freeze = true
  private root = 60
  private seed = 1

  constructor(private readonly sampleRate: number) {}

  noteOn(note: number, velocity: number, time?: number) {
    this.clock.noteOn(note, velocity, time, (midi, level) => this.begin(midi, level))
  }

  noteOff(note: number, time?: number) {
    this.clock.noteOff(note, time, (midi) => this.end(midi))
  }

  connect(destination: AudioNode) {
    bindMono(this, (frames) => this.render(frames), destination, this.link)
  }

  disconnect() {
    releaseOutput(this, this.link)
  }

  setBuffer(channel: Float32Array | null) {
    const next = channel && channel.length > 8 ? channel : null
    if (next === this.buffer) return
    this.buffer = next
  }

  setParam(id: string, value: number) {
    if (!Number.isFinite(value)) return
    if (id === 'position') {
      const next = clamp(value, 0, 1)
      if (Math.abs(next - this.position) > 1e-4) {
        this.position = next
        this.head = next
      }
      return
    }
    if (id === 'size') this.size = clamp(value, 10, 400)
    else if (id === 'density') this.density = clamp(value, 1, 40)
    else if (id === 'spray') this.spray = clamp(value, 0, 1)
    else if (id === 'pitch') this.pitch = clamp(value, -24, 24)
    else if (id === 'freeze') this.freeze = value >= 0.5
    else if (id === 'root') this.root = clamp(Math.round(value), 0, 127)
  }

  tick() {
    this.clock.advance(1, this.sampleRate, (note, velocity) => this.begin(note, velocity), (note) => this.end(note))
    const buffer = this.buffer
    if (!buffer) return 0
    let mix = 0
    const overlap = Math.max(1, (this.density * this.size) / 1000)
    const gain = 0.85 / Math.sqrt(overlap)
    for (const stream of this.streams) {
      const releaseSamples = Math.max(1, 0.08 * this.sampleRate)
      stream.env = stream.released ? stream.env * Math.exp(-1 / releaseSamples) : Math.min(1, stream.env + 1 / Math.max(1, 0.004 * this.sampleRate))
      if (!stream.released) this.spawn(stream, buffer)
      for (const grain of stream.grains) {
        if (!grain.on) continue
        const phase = grain.age / grain.length
        const window = 0.5 * (1 - Math.cos(2 * Math.PI * phase))
        mix += hermite(buffer, grain.cursor) * window * stream.env * stream.velocity
        grain.cursor += grain.rate
        grain.age += 1
        if (grain.age >= grain.length || grain.cursor >= buffer.length - 1) grain.on = false
      }
      stream.grains = stream.grains.filter((grain) => grain.on)
      if (stream.released && stream.env < 0.0008 && !stream.grains.length) stream.note = -1
    }
    this.streams = this.streams.filter((stream) => stream.note >= 0)
    if (!this.freeze) this.head = (this.head + 1 / buffer.length) % 1
    return san(mix * gain)
  }

  render(frames: number) {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) out[i] = this.tick()
    return out
  }

  dispose() {
    this.disconnect()
    this.streams = []
    this.buffer = null
  }

  private begin(note: number, velocity: number) {
    const midi = clamp(Math.round(note), 0, 127)
    const level = clamp(velocity, 0, 1)
    let stream = this.streams.find((item) => item.note === midi)
    if (!stream) {
      if (this.streams.length >= 8) stream = this.streams.find((item) => item.released) ?? this.streams[0]
      else {
        stream = { note: midi, velocity: level, released: false, env: 0, spawn: 0, grains: [] }
        this.streams.push(stream)
      }
    }
    if (!stream) return
    stream.note = midi
    stream.velocity = level
    stream.released = false
    stream.env = 0
    stream.spawn = 1e9
    stream.grains = []
    this.head = this.position
  }

  private end(note: number) {
    const midi = Math.round(note)
    for (const stream of this.streams) if (stream.note === midi) stream.released = true
  }

  private spawn(stream: Stream, buffer: Float32Array) {
    const interval = this.sampleRate / this.density
    stream.spawn += 1
    if (stream.spawn < interval) return
    stream.spawn -= interval
    if (stream.grains.length >= 16) return
    const length = Math.max(8, Math.round((this.size / 1000) * this.sampleRate))
    const semis = this.pitch + (stream.note - this.root)
    const rate = 2 ** (semis / 12)
    const jitter = (hashUnit(this.seed++) - 0.5) * 2 * this.spray * buffer.length * 0.2
    const cursor = clamp(this.head * (buffer.length - 1) + jitter, 0, buffer.length - 2)
    stream.grains.push({ cursor, age: 0, length, rate, on: true })
  }
}
