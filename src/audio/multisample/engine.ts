import { continuousCeiling } from '../liveStage'
import type { SampleBank } from './cache'
import { MemoryBank } from './cache'
import { isKeyswitch, selectLayers } from './map'
import { advancePlayhead, readFrame, readFrameAt, type ReadSpan } from './read'
import { openStream, type SampleStream } from './stream'
import type { DecodedSample, LoopMode, MappedLayer, MicPosition, SampleRef, SamplerProgram, ZoneTrigger } from './types'
import { dbToAmp, midiVelocity } from './types'

interface Voice {
  note: number
  vel: number
  trigger: ZoneTrigger
  released: boolean
  active: boolean
  age: number
  exclusive: number
  offBy: number
  env: number
  stage: 'attack' | 'hold' | 'decay' | 'sustain' | 'release'
  holdLeft: number
  pos: number
  tune: number
  gain: number
  pan: number
  micId: string
  loopMode: LoopMode
  looping: boolean
  loopStart: number
  loopEnd: number
  fade: number
  end: number
  attack: number
  decay: number
  sustain: number
  release: number
  audio: DecodedSample | null
  stream: SampleStream | null
  ref: SampleRef
  waited: number
  oneShot: boolean
}

interface Held {
  note: number
  velocity: number
  roundRobin: Record<number, number>
}

export interface SamplerNote {
  sample: number
  pitch: number
  vel: number
}

/** One note-on and the files it needs. Release samples are included so the tail is not silent. */
export interface PlannedNote {
  attackIds: string[]
  samples: SampleRef[]
}

/**
 * Plays a SamplerProgram. Call noteOn / noteOff, then render().
 * A sample that is still downloading keeps the voice until it arrives.
 */
export class SamplerInstrument {
  private currentProgram: SamplerProgram | null = null
  private readonly voices: Voice[] = []
  private readonly held: Held[] = []
  private readonly counters: Record<number, number> = {}
  private key = null as number | null
  private mics = new Map<string, MicPosition>()
  private voiceLimit = 32
  private left = new Float32Array(0)
  private right = new Float32Array(0)
  private toneL = 0
  private toneR = 0
  private readonly bank: SampleBank

  constructor(
    readonly sampleRate: number,
    bank?: SampleBank,
  ) {
    this.bank = bank ?? new MemoryBank()
  }

  /** Envelope, tune, tone, and loop. Sounding notes keep playing. */
  setPlay(play: SamplerProgram['play']) {
    if (!this.currentProgram || !play) return
    const previous = this.currentProgram.play?.tune ?? 0
    this.currentProgram.play = play
    const ratio = 2 ** (((play.tune ?? 0) - previous) / 12)
    for (const voice of this.voices) {
      if (!voice.active) continue
      voice.attack = Math.max(0, play.attack)
      voice.decay = Math.max(0, play.decay)
      voice.sustain = Math.max(0, Math.min(1, play.sustain))
      voice.release = Math.max(0.005, play.release)
      if ((play.tune ?? 0) !== previous) voice.tune *= ratio
      if (play.loop === true) voice.looping = true
      else if (play.loop === false) voice.looping = false
    }
  }

  setProgram(program: SamplerProgram | null) {
    this.currentProgram = program
    this.silence()
    for (const group of Object.keys(this.counters)) delete this.counters[Number(group)]
    this.mics = new Map((program?.mics ?? []).map((mic) => [mic.id, { ...mic }]))
    this.key = program?.defaultSwitch ?? null
    this.voiceLimit = Math.max(1, program?.voices ?? 32)
  }

  /** Stop sounding voices without forgetting the program, mics, or round-robin. */
  silence() {
    this.voices.length = 0
    this.held.length = 0
  }

  get program() {
    return this.currentProgram
  }

  setVoiceLimit(limit: number) {
    this.voiceLimit = Math.max(1, Math.round(limit))
  }

  setMicGain(id: string, gain: number) {
    const mic = this.mic(id)
    mic.gain = Math.max(0, Math.min(1, gain))
  }

  setMicMute(id: string, mute: boolean) {
    this.mic(id).mute = mute
  }

  applyMics(mics: MicPosition[]) {
    for (const mic of mics) {
      const live = this.mic(mic.id)
      live.gain = mic.gain
      live.pan = mic.pan
      live.mute = mic.mute
      live.name = mic.name
    }
  }

  keyswitch() {
    return this.key
  }

  setKeyswitch(note: number | null) {
    this.key = note
  }

  /** Layers that would sound, without starting voices. */
  preview(note: number, velocity: number, trigger: ZoneTrigger = 'attack') {
    if (!this.currentProgram) return []
    return selectLayers(this.currentProgram, {
      note,
      velocity: midiVelocity(velocity),
      keyswitch: this.key,
      roundRobin: this.counters,
      trigger,
    }).layers
  }

  /**
   * Files a series of note-ons will play, in the same order as the audio callback.
   * Round-robin and keyswitches advance on a copy, so this does not change the live instrument.
   */
  plan(events: SamplerNote[]): PlannedNote[] {
    const program = this.currentProgram
    if (!program) return []
    const counters = { ...this.counters }
    let key = this.key
    const ordered = events.filter((event) => event.vel > 0).slice().sort((a, b) => a.sample - b.sample)
    const notes: PlannedNote[] = []
    for (const event of ordered) {
      const midi = Math.round(event.pitch)
      if (isKeyswitch(program, midi)) {
        key = midi
        continue
      }
      const velocity = midiVelocity(event.vel)
      if (!velocity) continue
      const attack = selectLayers(program, {
        note: midi,
        velocity,
        keyswitch: key,
        roundRobin: counters,
        trigger: 'attack',
      })
      const release = selectLayers(program, {
        note: midi,
        velocity,
        keyswitch: key,
        roundRobin: counters,
        trigger: 'release',
      })
      for (const group of attack.advance) counters[group] = (counters[group] ?? 0) + 1
      const samples: SampleRef[] = []
      const seen = new Set<string>()
      const attackIds: string[] = []
      for (const layer of attack.layers) {
        if (!seen.has(layer.sample.id)) {
          seen.add(layer.sample.id)
          samples.push(layer.sample)
        }
        attackIds.push(layer.sample.id)
      }
      for (const layer of release.layers) {
        if (seen.has(layer.sample.id)) continue
        seen.add(layer.sample.id)
        samples.push(layer.sample)
      }
      if (attackIds.length) notes.push({ attackIds, samples })
    }
    return notes
  }

  noteOn(note: number, velocity: number): MappedLayer[] {
    const program = this.currentProgram
    const midi = Math.round(note)
    if (!program) return []
    if (isKeyswitch(program, midi)) {
      this.key = midi
      return []
    }
    const vel = midiVelocity(velocity)
    if (!vel) return this.noteOff(midi)
    const snapshot = { ...this.counters }
    const mapped = selectLayers(program, {
      note: midi,
      velocity: vel,
      keyswitch: this.key,
      roundRobin: snapshot,
      trigger: 'attack',
    })
    this.held.push({ note: midi, velocity: vel, roundRobin: snapshot })
    for (const group of mapped.advance) this.counters[group] = (this.counters[group] ?? 0) + 1
    this.start(midi, velocity > 1 ? vel / 127 : velocity, mapped.layers, 'attack')
    return mapped.layers
  }

  noteOff(note: number, velocity = 0): MappedLayer[] {
    const program = this.currentProgram
    const midi = Math.round(note)
    if (!program) return []
    const heldIndex = this.held.findIndex((item) => item.note === midi)
    const held = heldIndex >= 0 ? this.held.splice(heldIndex, 1)[0] : undefined
    for (const voice of this.voices) {
      if (!voice.active || voice.note !== midi || voice.trigger !== 'attack') continue
      if (voice.oneShot) continue
      if (voice.loopMode === 'sustain') voice.looping = false
      voice.released = true
      voice.stage = 'release'
    }
    const vel = held?.velocity ?? midiVelocity(velocity || 0.8)
    const mapped = selectLayers(program, {
      note: midi,
      velocity: vel,
      keyswitch: this.key,
      roundRobin: held?.roundRobin ?? this.counters,
      trigger: 'release',
    })
    const amp = velocity > 1 ? Math.max(0.05, velocity / 127) : Math.max(0.05, held ? held.velocity / 127 : velocity || 0.8)
    this.start(midi, amp, mapped.layers, 'release')
    return mapped.layers
  }

  activeVoices() {
    return this.voices.filter((voice) => voice.active).length
  }

  /**
   * Stereo block. The returned arrays are reused on the next call;
   * copy them if they need to outlive this render.
   */
  render(frames: number): [Float32Array, Float32Array] {
    const count = Math.max(0, frames | 0)
    if (this.left.length !== count) {
      this.left = new Float32Array(count)
      this.right = new Float32Array(count)
    } else {
      this.left.fill(0)
      this.right.fill(0)
    }
    const programGain = dbToAmp(this.currentProgram?.gainDb ?? 0)
    const sr = this.sampleRate
    for (let i = 0; i < count; i++) {
      let left = 0
      let right = 0
      for (const voice of this.voices) {
        if (!voice.active) continue
        voice.age += 1
        if (!voice.audio && !voice.stream) {
          voice.stream = openStream(this.bank, voice.ref)
          if (!voice.stream) voice.audio = this.bank.get(voice.ref)
          if (!voice.audio && !voice.stream && (voice.waited === 0 || voice.waited % Math.max(1, sr >> 2) === 0)) this.bank.request(voice.ref)
          voice.waited += 1
          if (!voice.audio && !voice.stream && voice.waited > sr * 12) voice.active = false
          continue
        }
        const env = this.envelope(voice, sr)
        if (!voice.active) continue
        const channelL = voice.audio?.channels[0]
        if (!voice.stream && !channelL?.length) continue
        const channelR = voice.audio?.channels[1] ?? channelL
        const sourceRate = voice.stream?.sampleRate || voice.audio?.sampleRate || sr
        const rate = (sourceRate / sr) * voice.tune
        const span = spanOf(voice)
        const length = voice.stream?.frames || channelL?.length || 0
        const sampleL = voice.stream
          ? readFrameAt((index) => voice.stream!.at(0, index), length, voice.pos, rate, span)
          : readFrame(channelL!, voice.pos, rate, span)
        const sampleR = voice.stream
          ? voice.stream.channels > 1
            ? readFrameAt((index) => voice.stream!.at(1, index), length, voice.pos, rate, span)
            : sampleL
          : channelR === channelL
            ? sampleL
            : readFrame(channelR!, voice.pos, rate, span)
        const mic = this.mics.get(voice.micId)
        const micGain = !mic || mic.mute ? 0 : mic.gain
        const amp = env * voice.vel * voice.gain * micGain * programGain
        const pan = clamp(voice.pan + (mic?.pan ?? 0), -1, 1)
        left += sampleL * amp * (pan <= 0 ? 1 : 1 - pan)
        right += sampleR * amp * (pan >= 0 ? 1 : 1 + pan)
        const limit = voice.end > 0 ? voice.end : length
        const stepped = advancePlayhead(voice.pos, rate, limit, span)
        voice.pos = stepped.pos
        if (stepped.done && voice.stage !== 'release') {
          voice.released = true
          voice.stage = 'release'
        }
        if (stepped.done && voice.stage === 'release' && voice.env < 0.001) voice.active = false
      }
      const tone = this.currentProgram?.play?.tone
      let outL = left
      let outR = right
      if (tone != null && tone < 17000) {
        const coeff = 1 - Math.exp((-2 * Math.PI * Math.min(tone, sr * 0.45)) / sr)
        this.toneL += (left - this.toneL) * coeff
        this.toneR += (right - this.toneR) * coeff
        outL = this.toneL
        outR = this.toneR
      }
      this.left[i] = soft(outL)
      this.right[i] = soft(outR)
    }
    this.voices.splice(0, this.voices.length, ...this.voices.filter((voice) => voice.active))
    return [this.left, this.right]
  }

  private start(note: number, vel: number, layers: MappedLayer[], trigger: ZoneTrigger) {
    for (const layer of layers) {
      const zone = layer.zone
      if (zone.exclusive > 0) {
        for (const voice of this.voices) {
          if (voice.active && (voice.exclusive === zone.exclusive || voice.offBy === zone.exclusive)) voice.released = true
        }
      }
    }
    const room = Math.max(1, this.voiceLimit)
    for (const layer of layers) {
      while (this.voices.filter((voice) => voice.active && !voice.released).length >= room) {
        const victim = [...this.voices].filter((voice) => voice.active && !voice.released).sort((a, b) => b.age - a.age)[0]
        if (!victim) break
        victim.released = true
        victim.stage = 'release'
        victim.release = Math.min(victim.release > 0 ? victim.release : 0.03, 0.012)
      }
      const zone = layer.zone
      const play = this.currentProgram?.play
      const attack = play ? play.attack : zone.ampeg.attack
      const decay = play ? play.decay : zone.ampeg.decay
      const sustain = play ? play.sustain : zone.ampeg.sustain
      const release = Math.max(0.005, play ? play.release : zone.ampeg.release)
      const ref = layer.sample
      const stream = openStream(this.bank, ref)
      const audio = stream ? null : this.bank.get(ref)
      if (!audio && !stream) this.bank.request(ref)
      const forced = play?.loop
      let loop = zone.loopMode === 'loop' || zone.loopMode === 'sustain'
      let loopMode = zone.loopMode
      let loopStart = zone.loopStart
      let loopEnd = zone.loopEnd > zone.loopStart ? zone.loopEnd : 0
      if (forced === true) {
        loop = true
        loopMode = 'loop'
        if (!(loopEnd > loopStart)) {
          loopStart = Math.max(0, zone.offset)
          loopEnd = zone.end > loopStart + 16 ? zone.end : loopEnd
        }
      } else if (forced === false) {
        loop = false
        loopMode = 'one-shot'
      }
      const fade = loop && loopEnd - loopStart > 16 ? Math.min(256, Math.floor((loopEnd - loopStart) / 8)) : 0
      this.voices.push({
        note,
        vel: Math.max(0, Math.min(1, vel)),
        trigger,
        released: false,
        active: true,
        age: 0,
        exclusive: zone.exclusive,
        offBy: zone.offBy,
        env: attack <= 0 ? 1 : 0,
        stage: attack <= 0 ? (zone.ampeg.hold > 0 && !play ? 'hold' : decay > 0 ? 'decay' : 'sustain') : 'attack',
        holdLeft: Math.round((play ? 0 : zone.ampeg.hold) * this.sampleRate),
        pos: Math.max(0, zone.offset),
        tune: layer.tuneRatio * (play?.tune ? 2 ** (play.tune / 12) : 1),
        gain: dbToAmp(zone.gainDb),
        pan: zone.pan,
        micId: zone.mic,
        loopMode,
        looping: loop,
        loopStart,
        loopEnd,
        fade,
        end: zone.end,
        attack: Math.max(0, attack),
        decay: Math.max(0, decay),
        sustain: clamp(sustain, 0, 1),
        release,
        audio,
        stream,
        ref,
        waited: 0,
        oneShot: zone.loopMode === 'one-shot',
      })
    }
  }

  private envelope(voice: Voice, sr: number) {
    if (voice.released && voice.stage !== 'release') voice.stage = 'release'
    if (voice.stage === 'attack') {
      const samples = Math.max(1, voice.attack * sr)
      voice.env += 1 / samples
      if (voice.env >= 1) {
        voice.env = 1
        voice.stage = voice.holdLeft > 0 ? 'hold' : 'decay'
      }
    } else if (voice.stage === 'hold') {
      voice.holdLeft -= 1
      voice.env = 1
      if (voice.holdLeft <= 0) voice.stage = 'decay'
    } else if (voice.stage === 'decay') {
      const samples = Math.max(1, voice.decay * sr)
      voice.env += (voice.sustain - voice.env) * (1 - Math.exp(-1 / samples))
      if (Math.abs(voice.env - voice.sustain) < 0.0008) voice.stage = 'sustain'
    } else if (voice.stage === 'release') {
      const samples = Math.max(1, voice.release * sr)
      voice.env *= Math.exp(-1 / samples)
      if (voice.env < 0.0008) {
        voice.env = 0
        voice.active = false
      }
    }
    return voice.env
  }

  private mic(id: string) {
    const found = this.mics.get(id)
    if (found) return found
    const made: MicPosition = { id, name: id, gain: 1, pan: 0, mute: false }
    this.mics.set(id, made)
    return made
  }
}

export function renderSampler(program: SamplerProgram, events: SamplerNote[], sampleRate: number, length: number, bank: SampleBank) {
  const instrument = new SamplerInstrument(sampleRate, bank)
  instrument.setProgram(program)
  const ordered = events.slice().sort((a, b) => a.sample - b.sample || b.vel - a.vel)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  let cursor = 0
  let offset = 0
  while (offset < length) {
    while (cursor < ordered.length && ordered[cursor].sample <= offset) {
      const event = ordered[cursor]
      if (event.vel <= 0) instrument.noteOff(event.pitch, event.vel)
      else instrument.noteOn(event.pitch, event.vel)
      cursor += 1
    }
    const next = ordered[cursor]?.sample ?? length
    const count = Math.min(128, length - offset, Math.max(1, next - offset))
    const block = instrument.render(count)
    left.set(block[0], offset)
    right.set(block[1], offset)
    offset += count
  }
  return [left, right] as [Float32Array, Float32Array]
}

function spanOf(voice: Voice): ReadSpan {
  return {
    loop: voice.looping && voice.loopEnd > voice.loopStart + 1,
    loopStart: voice.loopStart,
    loopEnd: voice.loopEnd,
    fade: voice.fade,
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function soft(value: number) {
  return continuousCeiling(value)
}
