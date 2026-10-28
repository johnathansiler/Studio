// grid-scheduler-start
function gridBeatAt(index, interval, swing) {
  const delay = index % 2 === 1 ? swing * interval : 0
  return index * interval + delay
}

function firstGridIndex(beat, interval, swing) {
  if (!(interval > 0)) return 0
  let index = Math.floor((beat - 1e-8) / interval)
  if (index < 0) index = 0
  for (let step = 0; step < 8; step++) {
    if (gridBeatAt(index, interval, swing) >= beat - 1e-9) return index
    index += 1
  }
  return index
}

function gridSample(beat, originContext, originBeat, tempo, sampleRate) {
  const time = originContext + (beat - originBeat) * (60 / tempo)
  return Math.round(time * sampleRate)
}

function takeGridHits(cursor, blockFrame, frames, sampleRate, originContext, originBeat, tempo, interval, swing, armedBeat, releaseBeat) {
  const hits = []
  if (!(interval > 0) || !(tempo > 0) || !(sampleRate > 0) || frames <= 0) return hits
  const blockEnd = blockFrame + frames
  let late = false
  for (let guard = 0; guard < 64; guard++) {
    const beat = gridBeatAt(cursor.nextIndex, interval, swing)
    if (!(beat < releaseBeat - 1e-9)) break
    if (beat < armedBeat - 1e-9) {
      cursor.nextIndex += 1
      continue
    }
    const sample = gridSample(beat, originContext, originBeat, tempo, sampleRate)
    if (sample >= blockEnd) break
    if (sample >= blockFrame) {
      hits.push(sample - blockFrame)
      cursor.nextIndex += 1
      continue
    }
    late = true
    cursor.nextIndex += 1
    while (guard < 64) {
      const nextBeat = gridBeatAt(cursor.nextIndex, interval, swing)
      if (!(nextBeat < releaseBeat - 1e-9)) break
      const nextSample = gridSample(nextBeat, originContext, originBeat, tempo, sampleRate)
      if (nextSample >= blockFrame) break
      cursor.nextIndex += 1
      guard += 1
    }
  }
  if (late && hits[0] !== 0) hits.unshift(0)
  return hits
}
// grid-scheduler-end

class KeysProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.voices = []
    for (let i = 0; i < 16; i++) {
      this.voices.push({
        on: false, pitch: 60, vel: 0, env: 0, phase: 0, drum: -1, pos: 0, every: 0, left: 0, age: 0,
        grid: 0, nextIndex: 0, swingAmt: 0, originContext: 0, originBeat: 0, tempo: 120,
        armedBeat: 0, releaseBeat: Infinity, sampleId: '', hits: null, hitAt: 0, gridDone: false,
      })
    }
    this.drums = []
    this.pads = new Map()
    this.pending = []
    this.sab = null
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === 'samples') {
        this.drums = data.samples || []
        return
      }
      if (data.type === 'pad-sample') {
        this.pads.set(data.id, data.samples)
        return
      }
      if (data.type === 'sab') {
        this.sab = new Int32Array(data.buffer)
        return
      }
      this.pending.push(data)
    }
  }

  claim(pitch, drum, reusePitch) {
    let reuse = null
    let free = null
    let oldest = this.voices[0]
    for (const voice of this.voices) {
      if (voice.on) voice.age = (voice.age || 0) + 1
      if ((reusePitch || drum < 0) && voice.on && voice.pitch === pitch) reuse = voice
      if (!voice.on && !free) free = voice
      if ((voice.age || 0) >= (oldest.age || 0)) oldest = voice
    }
    const voice = reuse || free || oldest
    voice.age = 0
    return voice
  }

  take(data) {
    if (data.type === 'on' || data.type === 'repeat') {
      const grid = data.grid > 0
      const voice = this.claim(data.pitch, data.drum == null ? -1 : data.drum, grid)
      voice.on = true
      voice.pitch = data.pitch
      voice.vel = data.velocity
      voice.env = grid ? 0 : 1
      voice.phase = 0
      voice.drum = data.drum == null ? -1 : data.drum
      voice.pos = grid ? 1e12 : 0
      voice.rate = data.rate || 1
      voice.decay = data.decay == null ? 1 : data.decay
      voice.attack = data.attack || 0
      voice.cut = data.filter == null ? 1 : data.filter
      voice.low = 0
      voice.swing = data.swing || 0
      voice.odd = true
      voice.sampleId = data.sampleId || ''
      if (grid) {
        voice.every = 0
        voice.left = 0
        voice.grid = data.grid
        voice.swingAmt = data.swing || 0
        voice.originContext = data.originContext || 0
        voice.originBeat = data.originBeat || 0
        voice.tempo = data.tempo || 120
        voice.armedBeat = data.armedBeat || 0
        voice.releaseBeat = Infinity
        voice.gridDone = false
        voice.nextIndex = firstGridIndex(voice.armedBeat, voice.grid, voice.swingAmt)
      } else {
        voice.grid = 0
        voice.every = data.type === 'repeat' ? data.every : 0
        voice.left = voice.every > 0 ? voice.every * (1 + (voice.swing || 0)) : 0
        this.port.postMessage({ type: 'onset', frame: currentFrame, pitch: data.pitch })
      }
      return
    }
    if (data.type === 'gain') {
      for (const voice of this.voices) {
        if (voice.on && voice.pitch === data.pitch) voice.vel = data.velocity
      }
      return
    }
    if (data.type === 'off') {
      for (const voice of this.voices) {
        if (voice.on && voice.pitch === data.pitch) {
          voice.every = 0
          if (data.releaseBeat == null) {
            voice.grid = 0
            voice.env = Math.min(voice.env, 0.15)
          } else voice.releaseBeat = data.releaseBeat
        }
      }
    }
  }

  drainSab() {
    const sab = this.sab
    if (!sab) return
    let read = Atomics.load(sab, 1)
    const write = Atomics.load(sab, 0)
    if (write - read > 8) read = write - 8
    while (read < write) {
      const base = 2 + (read % 8) * 4
      const kind = Atomics.load(sab, base)
      this.take({
        type: kind === 2 ? 'repeat' : kind === 0 ? 'off' : 'on',
        pitch: Atomics.load(sab, base + 1),
        velocity: Atomics.load(sab, base + 2) / 1000,
        drum: Atomics.load(sab, base + 3),
        every: 0,
      })
      read += 1
    }
    Atomics.store(sab, 1, read)
  }

  process(_inputs, outputs) {
    this.drainSab()
    while (this.pending.length) this.take(this.pending.shift())
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    const rate = sampleRate
    const blockFrame = currentFrame
    for (const voice of this.voices) {
      voice.hits = null
      voice.hitAt = 0
      if (!(voice.grid > 0)) continue
      voice.hits = takeGridHits(
        voice,
        blockFrame,
        out.length,
        rate,
        voice.originContext,
        voice.originBeat,
        voice.tempo,
        voice.grid,
        voice.swingAmt || 0,
        voice.armedBeat,
        voice.releaseBeat == null ? Infinity : voice.releaseBeat,
      )
      const endBeat = voice.originBeat + ((currentTime + out.length / rate) - voice.originContext) * (voice.tempo / 60)
      if (voice.releaseBeat < Infinity && endBeat >= voice.releaseBeat) voice.gridDone = true
    }
    for (let i = 0; i < out.length; i++) {
      let sample = 0
      for (const voice of this.voices) {
        if (!voice.on) continue
        if (voice.hits && voice.hitAt < voice.hits.length && voice.hits[voice.hitAt] === i) {
          voice.hitAt += 1
          voice.env = 1
          voice.pos = 0
          voice.phase = 0
          voice.low = 0
          this.port.postMessage({ type: 'onset', frame: blockFrame + i, pitch: voice.pitch })
        }
        if (voice.every > 0) {
          voice.left -= 1
          if (voice.left <= 0) {
            voice.odd = !voice.odd
            voice.left = voice.every * (voice.odd ? (1 + (voice.swing || 0)) : Math.max(0.25, 1 - (voice.swing || 0)))
            voice.env = 1
            voice.pos = 0
            voice.phase = 0
            voice.low = 0
          }
        }
        const custom = voice.sampleId && this.pads ? this.pads.get(voice.sampleId) : null
        const buffer = custom || (voice.drum >= 0 ? this.drums[voice.drum] : null)
        if (buffer) {
          const limit = buffer.length * (voice.decay == null ? 1 : voice.decay)
          if (voice.pos < limit) {
            const idx = Math.min(buffer.length - 1, voice.pos | 0)
            let hit = buffer[idx] * voice.vel
            if (voice.attack > 0) {
              const fade = voice.attack * buffer.length
              if (voice.pos < fade) hit *= voice.pos / Math.max(1, fade)
            }
            if (voice.cut < 0.999) {
              voice.low += (hit - (voice.low || 0)) * Math.max(0.02, voice.cut)
              hit = voice.low
            }
            sample += hit
            voice.pos += voice.rate || 1
          } else if (voice.every <= 0 && !(voice.grid > 0)) voice.on = false
        } else {
          const freq = 440 * 2 ** ((voice.pitch - 69) / 12)
          voice.phase += freq / rate
          const tone = Math.sin(2 * Math.PI * voice.phase)
          sample += tone * voice.env * voice.vel * 0.35
          voice.env *= 0.9996
          if (voice.env < 0.0008 && !(voice.grid > 0)) voice.on = false
        }
      }
      out[i] = sample
    }
    for (const voice of this.voices) {
      if (!voice.gridDone) continue
      voice.grid = 0
      voice.gridDone = false
      voice.hits = null
      if (voice.drum < 0 && !voice.sampleId) voice.env = Math.min(voice.env, 0.15)
    }
    return true
  }
}

registerProcessor('keys-processor', KeysProcessor)
