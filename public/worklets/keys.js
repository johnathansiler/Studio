class KeysProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.voices = []
    for (let i = 0; i < 16; i++) {
      this.voices.push({ on: false, pitch: 60, vel: 0, env: 0, phase: 0, drum: -1, pos: 0, every: 0, left: 0, age: 0 })
    }
    this.drums = []
    this.pending = []
    this.sab = null
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === 'samples') {
        this.drums = data.samples || []
        return
      }
      if (data.type === 'sab') {
        this.sab = new Int32Array(data.buffer)
        return
      }
      this.pending.push(data)
    }
  }

  claim(pitch, drum) {
    let reuse = null
    let free = null
    let oldest = this.voices[0]
    for (const voice of this.voices) {
      if (voice.on) voice.age = (voice.age || 0) + 1
      if (drum < 0 && voice.on && voice.pitch === pitch) reuse = voice
      if (!voice.on && !free) free = voice
      if ((voice.age || 0) >= (oldest.age || 0)) oldest = voice
    }
    const voice = reuse || free || oldest
    voice.age = 0
    return voice
  }

  take(data) {
    if (data.type === 'on' || data.type === 'repeat') {
      const voice = this.claim(data.pitch, data.drum == null ? -1 : data.drum)
      voice.on = true
      voice.pitch = data.pitch
      voice.vel = data.velocity
      voice.env = 1
      voice.phase = 0
      voice.drum = data.drum
      voice.pos = 0
      voice.rate = data.rate || 1
      voice.decay = data.decay == null ? 1 : data.decay
      voice.attack = data.attack || 0
      voice.cut = data.filter == null ? 1 : data.filter
      voice.low = 0
      voice.swing = data.swing || 0
      voice.odd = true
      voice.every = data.type === 'repeat' ? data.every : 0
      voice.left = voice.every > 0 ? voice.every * (1 + voice.swing) : 0
      this.port.postMessage({ type: 'onset', frame: currentFrame, pitch: data.pitch })
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
          voice.env = Math.min(voice.env, 0.15)
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
    for (let i = 0; i < out.length; i++) {
      let sample = 0
      for (const voice of this.voices) {
        if (!voice.on) continue
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
        if (voice.drum >= 0 && this.drums[voice.drum]) {
          const buffer = this.drums[voice.drum]
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
          } else if (voice.every <= 0) voice.on = false
        } else {
          const freq = 440 * 2 ** ((voice.pitch - 69) / 12)
          voice.phase += freq / rate
          const tone = Math.sin(2 * Math.PI * voice.phase)
          sample += tone * voice.env * voice.vel * 0.35
          voice.env *= 0.9996
          if (voice.env < 0.0008) voice.on = false
        }
      }
      out[i] = sample
    }
    return true
  }
}

registerProcessor('keys-processor', KeysProcessor)
