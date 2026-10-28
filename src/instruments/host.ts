import type { SampleProgramState } from './engine/types'
import { instrumentBank, type SampleBank } from './engine/bank'
import { loadInstrument, type LoadedInstrument } from './engine/load'
import type { StripNodes } from '../audio/strips'
import type { Project } from '../model/types'

interface Scheduled {
  pitch: number
  vel: number
  time: number
}

interface Live {
  script: ScriptProcessorNode | null
  gain: GainNode
  instrument: LoadedInstrument | null
  revision: number
  savedArticulation: string
  notes: Scheduled[]
}

/**
 * Plays sample-instrument tracks into the strip.
 * The bank and IndexedDB live on the main thread, so this uses the same
 * script-processor fallback the rack uses when a worklet cannot see the cache.
 */
export class SampleHost {
  constructor(private bank: SampleBank = instrumentBank()) {}

  private lives = new Map<string, Live>()
  private pending = new Map<string, Scheduled[]>()

  sync(ctx: AudioContext, project: Project, strips: Map<string, StripNodes>) {
    for (const track of project.tracks) {
      if (track.type !== 'midi' || track.instrument !== 'sample') continue
      const strip = strips.get(track.id)
      if (!strip) continue
      const live = this.ensure(ctx, track.id, strip)
      this.push(live, track.sampleProgram ?? null)
      const queued = this.pending.get(track.id)
      if (queued?.length) {
        live.notes.push(...queued)
        this.pending.delete(track.id)
      }
      live.notes.sort((a, b) => a.time - b.time)
    }
    for (const id of [...this.lives.keys()]) {
      const track = project.tracks.find((item) => item.id === id)
      if (!track || track.instrument !== 'sample') this.drop(id)
    }
  }

  note(trackId: string, pitch: number, vel: number, time: number) {
    const item = { pitch, vel, time }
    const live = this.lives.get(trackId)
    if (!live) {
      const queue = this.pending.get(trackId) ?? []
      queue.push(item)
      this.pending.set(trackId, queue)
      return
    }
    live.notes.push(item)
    live.notes.sort((a, b) => a.time - b.time)
  }

  allOff() {
    for (const live of this.lives.values()) {
      live.notes.length = 0
      live.instrument?.allOff()
    }
  }

  articulation(trackId: string) {
    return this.lives.get(trackId)?.instrument?.articulation() ?? ''
  }

  private ensure(ctx: AudioContext, id: string, strip: StripNodes) {
    const existing = this.lives.get(id)
    if (existing) return existing
    const gain = ctx.createGain()
    gain.connect(strip.input)
    const live: Live = { script: null, gain, instrument: null, revision: -1, savedArticulation: '', notes: [] }
    try {
      const script = ctx.createScriptProcessor(256, 0, 2)
      script.onaudioprocess = (event) => this.render(live, event)
      script.connect(gain)
      live.script = script
    } catch {
      /* the track stays quiet if the browser refuses the processor */
    }
    this.lives.set(id, live)
    return live
  }

  private push(live: Live, program: SampleProgramState | null) {
    if (!program) {
      live.instrument = null
      live.revision = -1
      return
    }
    const sampleRate = live.script?.context.sampleRate || 48000
    if (!live.instrument || live.revision !== program.revision) {
      live.instrument = loadInstrument(program.def, { sampleRate, bank: this.bank, controls: program.values })
      live.instrument.setArticulation(program.articulation)
      live.revision = program.revision
      live.savedArticulation = program.articulation
      void live.instrument.prepare()
      return
    }
    for (const [id, value] of Object.entries(program.values)) {
      if (live.instrument.control(id) !== value) live.instrument.setControl(id, value)
    }
    if (program.articulation !== live.savedArticulation) {
      live.instrument.setArticulation(program.articulation)
      live.savedArticulation = program.articulation
    }
  }

  private render(live: Live, event: AudioProcessingEvent) {
    const instrument = live.instrument
    const frames = event.outputBuffer.length
    const left = event.outputBuffer.getChannelData(0)
    const right = event.outputBuffer.numberOfChannels > 1 ? event.outputBuffer.getChannelData(1) : left
    left.fill(0)
    if (right !== left) right.fill(0)
    if (!instrument) return
    const rate = event.outputBuffer.sampleRate || live.script?.context.sampleRate || 48000
    const start = event.playbackTime || 0
    const end = start + frames / rate
    const due = live.notes.filter((item) => item.time < end)
    live.notes = live.notes.filter((item) => item.time >= end)
    due.sort((a, b) => a.time - b.time)
    let frame = 0
    let cursor = 0
    while (frame < frames) {
      const now = start + frame / rate
      while (cursor < due.length && due[cursor].time <= now + 0.5 / rate) {
        const item = due[cursor]
        cursor += 1
        if (item.vel > 0 && item.time < start - 2) continue
        instrument.note(item.pitch, item.vel)
      }
      const next = cursor < due.length ? due[cursor].time : end
      const nextFrame = Math.min(frames, Math.max(frame + 1, Math.round((next - start) * rate)))
      const count = Math.max(1, nextFrame - frame)
      const rendered = instrument.render(count)
      left.set(rendered[0].subarray(0, count), frame)
      if (right !== left) right.set(rendered[1].subarray(0, count), frame)
      frame += count
    }
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    this.lives.delete(id)
    try { live?.script?.disconnect() } catch { /* already gone */ }
    try { live?.gain.disconnect() } catch { /* already gone */ }
  }
}
