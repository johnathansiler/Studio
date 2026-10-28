import type { SampleBank } from './bank'
import { controlValues } from './controls'
import { keyswitchFor, selectZones, type SelectState } from './map'
import type { SampleInstrumentDef, SampleProgramState, SampleTrigger } from './types'
import { createSampleZoneVoice, type SampleZoneVoice } from './voice'

export interface LoadOptions {
  sampleRate?: number
  bank?: SampleBank
  controls?: Record<string, number>
  random?: () => number
}

export interface LoadedInstrument {
  readonly def: SampleInstrumentDef
  noteOn(note: number, velocity: number): void
  noteOff(note: number, velocity?: number): void
  /** Velocity 0 releases the note. Velocity is 0–1, or MIDI 1–127 when it is greater than 1. */
  note(note: number, velocity: number): void
  setControl(id: string, value: number): void
  setArticulation(id: string): void
  control(id: string): number
  articulation(): string
  render(frames: number): [Float32Array, Float32Array]
  prepare(): Promise<void>
  activeVoices(): number
  allOff(): void
}

interface LiveVoice {
  voice: SampleZoneVoice
  zoneGroup: number
  zoneOff: number
  born: number
  trigger: SampleTrigger
}

const MAX_VOICES = 24

function midiVelocity(velocity: number) {
  if (!(velocity > 0)) return 0
  if (velocity > 1) return Math.max(1, Math.min(127, Math.round(velocity)))
  return Math.max(1, Math.min(127, Math.round(velocity * 127)))
}

function seconds(controlMs: number, fallback: number | null) {
  if (fallback != null) return fallback
  return Math.max(0, controlMs) / 1000
}

/**
 * Build a playable instrument from a definition.
 * The layer builder can also call createSampleZoneVoice for one zone it already chose.
 */
export function loadInstrument(def: SampleInstrumentDef, options: LoadOptions = {}): LoadedInstrument {
  const sampleRate = options.sampleRate && options.sampleRate > 0 ? options.sampleRate : 48000
  const bank = options.bank
  const values = controlValues(def, options.controls)
  const state: SelectState = {
    articulation: def.defaultArticulation,
    rrMode: (values.rrMode ?? 0) >= 0.5 ? 'random' : 'sequential',
    rr: new Map(),
    velFade: values.velXfade ?? 0,
    mics: {},
    held: 0,
    random: options.random ?? Math.random,
  }
  const held = new Set<number>()
  const voices: LiveVoice[] = []
  let serial = 0
  let level = values.level ?? 0.85

  const syncMics = () => {
    state.velFade = values.velXfade ?? 0
    state.rrMode = (values.rrMode ?? 0) >= 0.5 ? 'random' : 'sequential'
    level = values.level ?? 0.85
    const mics: Record<string, number> = {}
    for (const mic of def.mics) mics[mic.id] = values[`mic:${mic.id}`] ?? mic.gain
    state.mics = mics
  }
  syncMics()

  const loopFrames = (zoneStart: number, zoneEnd: number, zoneCross: number) => {
    const length = Math.max(0, zoneEnd - zoneStart)
    if (!(length > 8)) return zoneCross
    if (zoneCross > 0) return zoneCross
    const fraction = values.loopXfade ?? 0
    return Math.round(fraction * Math.min(2048, length / 4))
  }

  const start = (note: number, velocity: number, trigger: SampleTrigger) => {
    if (!bank) return
    state.held = held.size
    const midi = midiVelocity(velocity)
    const picks = selectZones(def.zones, note, midi, trigger, state)
    const groups = new Set(picks.map((pick) => pick.zone.group).filter((group) => group > 0))
    for (const live of voices) {
      if (!live.voice.active) continue
      const sameNote = live.voice.note === note && live.trigger !== 'release' && trigger === 'attack'
      const choked = live.zoneOff > 0 && groups.has(live.zoneOff) && live.voice.note !== note
      if (sameNote || choked) live.voice.choke()
    }
    for (const pick of picks) {
      const zone = pick.zone
      const voice = createSampleZoneVoice(zone, note, velocity, {
        sampleRate,
        bank,
        gain: pick.gain,
        tune: values.tune ?? 0,
        attack: seconds(values.attack ?? 0, zone.attack),
        decay: seconds(values.decay ?? 0, zone.decay),
        sustain: values.sustain ?? zone.sustain ?? 1,
        release: seconds(values.release ?? 200, zone.release),
        loopCrossfade: loopFrames(zone.loopStart, zone.loopEnd, zone.loopCrossfade),
      })
      voices.push({ voice, zoneGroup: zone.group, zoneOff: zone.offBy, born: serial++, trigger: zone.trigger })
    }
    let active = voices.filter((live) => live.voice.active)
    if (active.length <= MAX_VOICES) return
    const released = active.filter((live) => live.trigger === 'release').sort((a, b) => a.born - b.born)
    const pool = (released.length ? released : active.slice().sort((a, b) => a.born - b.born)).slice()
    while (voices.filter((live) => live.voice.active).length > MAX_VOICES && pool.length) pool.shift()?.voice.choke()
  }

  return {
    def,
    noteOn(note, velocity) {
      const switched = keyswitchFor(def.articulations, note)
      if (switched) {
        state.articulation = switched
        return
      }
      if (!(velocity > 0)) {
        this.noteOff(note, 0)
        return
      }
      start(note, velocity, 'attack')
      start(note, velocity, 'first')
      start(note, velocity, 'legato')
      held.add(note)
    },
    noteOff(note, velocity = 0) {
      held.delete(note)
      for (const live of voices) {
        if (live.voice.note === note && live.trigger !== 'release') live.voice.release()
      }
      const releaseVel = velocity > 0 ? velocity : 0.8
      start(note, releaseVel, 'release')
    },
    note(note, velocity) {
      if (velocity > 0) this.noteOn(note, velocity)
      else this.noteOff(note, 0)
    },
    setControl(id, value) {
      values[id] = value
      syncMics()
    },
    setArticulation(id) {
      state.articulation = id
    },
    control(id) {
      return values[id] ?? 0
    },
    articulation() {
      return state.articulation
    },
    render(frames) {
      const left = new Float32Array(Math.max(0, frames))
      const right = new Float32Array(left.length)
      for (const live of voices) {
        if (!live.voice.active) continue
        live.voice.render(left, right)
      }
      if (level !== 1) {
        for (let i = 0; i < left.length; i++) {
          left[i] *= level
          right[i] *= level
        }
      }
      for (let i = voices.length - 1; i >= 0; i--) if (!voices[i].voice.active) voices.splice(i, 1)
      return [left, right]
    },
    async prepare() {
      if (!bank) return
      const ids = [...new Set(def.zones.map((zone) => zone.sampleId).filter(Boolean))]
      await Promise.all(ids.map(async (id) => {
        await bank.open(id)
        const zones = def.zones.filter((zone) => zone.sampleId === id)
        for (const zone of zones) {
          const end = zone.end > zone.start ? zone.end : bank.info(id)?.frames ?? 0
          await bank.prefetch(id, Math.max(0, zone.start), Math.max(1024, Math.min(end, zone.start + 8192) - zone.start))
          if (zone.loopEnd > zone.loopStart) await bank.prefetch(id, Math.max(0, zone.loopStart - 32), zone.loopEnd - zone.loopStart + 64)
        }
      }))
    },
    activeVoices() {
      return voices.filter((live) => live.voice.active).length
    },
    allOff() {
      held.clear()
      for (const live of voices) live.voice.choke()
    },
  }
}

export interface SampleEvent {
  sample: number
  pitch: number
  vel: number
}

/** Offline render. Pages needed by the notes are read from the bank before the loop runs. */
export async function renderSampleProgram(
  program: SampleProgramState,
  events: SampleEvent[],
  sampleRate: number,
  length: number,
  bank: SampleBank,
): Promise<[Float32Array, Float32Array]> {
  const instrument = loadInstrument(program.def, { sampleRate, bank, controls: program.values })
  if (program.articulation) instrument.setArticulation(program.articulation)
  await instrument.prepare()
  const ids = [...new Set(program.def.zones.map((zone) => zone.sampleId))]
  await Promise.all(ids.map(async (id) => {
    const info = bank.info(id)
    if (info) await bank.prefetch(id, 0, info.frames)
  }))
  const left = new Float32Array(Math.max(0, length))
  const right = new Float32Array(left.length)
  const ordered = events.slice().sort((a, b) => a.sample - b.sample || b.vel - a.vel)
  let cursor = 0
  let offset = 0
  while (offset < length) {
    while (cursor < ordered.length && ordered[cursor].sample <= offset) {
      const event = ordered[cursor]
      cursor += 1
      instrument.note(event.pitch, event.vel)
    }
    const next = ordered[cursor]?.sample ?? length
    const count = Math.min(128, length - offset, Math.max(1, next - offset))
    const rendered = instrument.render(count)
    left.set(rendered[0], offset)
    right.set(rendered[1], offset)
    offset += count
  }
  return [left, right]
}
