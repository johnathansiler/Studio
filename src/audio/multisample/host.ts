import { wantsLibrary } from '../../instruments/scaler/model'
import type { Project, Track } from '../../model/types'
import type { StripNodes } from '../strips'
import { SampleCache } from './cache'
import { SamplerInstrument, renderSampler, type SamplerNote } from './engine'
import { isPackAsset, packFromAsset } from './persist'
import type { SamplePack, SampleRef } from './types'

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>

export interface PrepareResult {
  /** Notes whose attack samples all failed. */
  missing: number
  /** Notes that selected at least one attack sample. */
  sounding: number
}

interface Queued {
  pitch: number
  vel: number
  time: number
}

interface Live {
  instrument: SamplerInstrument
  cache: SampleCache
  gain: GainNode | null
  script: ScriptProcessorNode | null
  signature: string
  notes: Queued[]
}

/**
 * Plays library tracks on the instrument strip.
 * The worklet rack is left alone. Notes play here for a library instrument, or for Scaler when its sound is Library.
 */
export class LibraryHost {
  private readonly lives = new Map<string, Live>()
  private readonly pending = new Map<string, Queued[]>()

  constructor(private readonly fetchImpl?: FetchLike) {}

  sync(ctx: AudioContext, project: Project, strips: Map<string, StripNodes>, assetOf: (id: string) => { id: string; name?: string; sampleRate: number; channels: Float32Array[] } | undefined) {
    const phone = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 520px), (max-height: 520px) and (orientation: landscape)').matches
    for (const track of project.tracks) {
      if (track.type !== 'midi' || !wantsLibrary(track) || !track.library) {
        if (!wantsLibrary(track)) this.drop(track.id)
        continue
      }
      const strip = strips.get(track.id)
      if (!strip) continue
      const live = this.ensure(track.id, ctx.sampleRate)
      this.attach(ctx, live, strip)
      this.installAssets(live, track, assetOf)
      const program = track.library
      const signature = `${program.id}:${program.zones.length}:${program.samples.length}:${program.zones[0]?.id ?? ''}:${program.zones[program.zones.length - 1]?.id ?? ''}`
      if (signature !== live.signature) {
        live.instrument.setProgram(program)
        live.signature = signature
      }
      live.instrument.setKeyswitch(program.defaultSwitch)
      live.instrument.applyMics(program.mics)
      live.instrument.setVoiceLimit(phone ? Math.min(12, program.voices) : program.voices)
      for (const note of this.pending.get(track.id) ?? []) live.notes.push(note)
      this.pending.delete(track.id)
      live.notes.sort((a, b) => a.time - b.time)
    }
  }

  note(trackId: string, pitch: number, vel: number, time: number) {
    const live = this.lives.get(trackId)
    if (!live) {
      const queue = this.pending.get(trackId) ?? []
      queue.push({ pitch, vel, time })
      this.pending.set(trackId, queue)
      return
    }
    live.notes.push({ pitch, vel, time })
    live.notes.sort((a, b) => a.time - b.time)
  }

  holdPack(trackId: string, pack: SamplePack) {
    this.ensure(trackId, 48000).cache.holdPack(pack)
  }

  holdAudio(trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) {
    const cache = this.ensure(trackId, 48000).cache
    for (const sample of samples) cache.holdAudio(sample.id, { sampleRate: sample.sampleRate, channels: sample.channels })
  }

  /**
   * Load every sample the notes will actually play, including later round-robins.
   * A note counts as missing only when none of its attack samples decode.
   */
  async prepare(trackId: string, track: Track, events: SamplerNote[], sampleRate: number): Promise<PrepareResult> {
    const program = track.library
    if (!program) return { missing: 0, sounding: 0 }
    const live = this.ensure(trackId, sampleRate)
    if (live.instrument.program !== program) live.instrument.setProgram(program)
    const planned = live.instrument.plan(events)
    const sounding = planned.length
    const samples = new Map<string, SampleRef>()
    for (const note of planned) {
      for (const sample of note.samples) samples.set(sample.id, sample)
    }
    const failed = new Set<string>()
    await Promise.all([...samples.values()].map(async (sample) => {
      if (!sample.url) {
        const held = live.cache.get(sample)
        if (held?.channels.some((channel) => channel.length > 0)) return
        if (sample.bufferId || sample.packId) return
        failed.add(sample.id)
        return
      }
      try {
        const decoded = await live.cache.load(sample)
        if (!decoded?.channels.some((channel) => channel.length > 0)) failed.add(sample.id)
      } catch {
        failed.add(sample.id)
      }
    }))
    let missing = 0
    for (const note of planned) {
      if (note.attackIds.length > 0 && note.attackIds.every((id) => failed.has(id))) missing += 1
    }
    return { missing, sounding }
  }

  renderOffline(trackId: string, track: Track, events: SamplerNote[], sampleRate: number, length: number) {
    const program = track.library
    if (!program) return [new Float32Array(length), new Float32Array(length)] as [Float32Array, Float32Array]
    const live = this.ensure(trackId, sampleRate)
    return renderSampler(program, events, sampleRate, length, live.cache)
  }

  allOff() {
    for (const live of this.lives.values()) {
      live.notes = []
      live.instrument.silence()
    }
  }

  private ensure(id: string, sampleRate: number) {
    const found = this.lives.get(id)
    if (found) {
      if (!found.script && found.instrument.sampleRate !== sampleRate) {
        found.instrument = new SamplerInstrument(sampleRate, found.cache)
        found.signature = ''
      }
      return found
    }
    const cache = new SampleCache(this.fetchImpl)
    const live: Live = {
      instrument: new SamplerInstrument(sampleRate, cache),
      cache,
      gain: null,
      script: null,
      signature: '',
      notes: [],
    }
    this.lives.set(id, live)
    return live
  }

  private attach(ctx: AudioContext, live: Live, strip: StripNodes) {
    if (live.script) return
    const gain = ctx.createGain()
    gain.connect(strip.input)
    let script: ScriptProcessorNode
    try {
      script = ctx.createScriptProcessor(256, 0, 2)
    } catch {
      live.gain = gain
      return
    }
    script.onaudioprocess = (event) => this.mix(live, event, ctx.sampleRate)
    script.connect(gain)
    live.script = script
    live.gain = gain
  }

  private mix(live: Live, event: AudioProcessingEvent, sampleRate: number) {
    const frames = event.outputBuffer.length
    const start = event.playbackTime
    const end = start + frames / sampleRate
    const due = live.notes.filter((note) => note.time < end)
    live.notes = live.notes.filter((note) => note.time >= end)
    due.sort((a, b) => a.time - b.time)
    const left = event.outputBuffer.getChannelData(0)
    const right = event.outputBuffer.getChannelData(1)
    let rendered = 0
    const run = (from: number, to: number) => {
      if (to <= from) return
      const block = live.instrument.render(to - from)
      left.set(block[0], from)
      if (right) right.set(block[1], from)
    }
    for (const note of due) {
      const at = Math.max(rendered, Math.min(frames, Math.round((note.time - start) * sampleRate)))
      run(rendered, at)
      if (note.vel <= 0) live.instrument.noteOff(note.pitch)
      else live.instrument.noteOn(note.pitch, note.vel)
      rendered = at
    }
    run(rendered, frames)
  }

  private installAssets(live: Live, track: Track, assetOf: (id: string) => { id?: string; name?: string; sampleRate: number; channels: Float32Array[] } | undefined) {
    const seen = new Set<string>()
    for (const sample of track.library?.samples ?? []) {
      if (sample.packId && !seen.has(sample.packId)) {
        seen.add(sample.packId)
        const packed = assetOf(sample.packId)
        if (packed && isPackAsset(packed)) {
          const pack = packFromAsset({ id: sample.packId, name: packed.name, channels: packed.channels })
          if (pack) live.cache.holdPack(pack)
        }
      }
      if (!sample.bufferId) continue
      const asset = assetOf(sample.bufferId)
      if (!asset?.channels?.length || isPackAsset(asset)) continue
      live.cache.holdAudio(sample.id, { sampleRate: asset.sampleRate, channels: asset.channels })
    }
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    if (!live) return
    try { live.script?.disconnect() } catch { /* already stopped */ }
    try { live.gain?.disconnect() } catch { /* already stopped */ }
    this.lives.delete(id)
    this.pending.delete(id)
  }
}
