class KeysProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.voices = []
    for (let i = 0; i < 16; i++) {
      this.voices.push({ on: false, pitch: 60, vel: 0, env: 0, phase: 0, drum: -1, pos: 0, every: 0, left: 0 })
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

  take(data) {
    if (data.type === 'on' || data.type === 'repeat') {
      let voice = this.voices[0]
      for (let i = 0; i < this.voices.length; i++) {
        if (!this.voices[i].on) {
          voice = this.voices[i]
          break
        }
      }
      voice.on = true
      voice.pitch = data.pitch
      voice.vel = data.velocity
      voice.env = 1
      voice.phase = 0
      voice.drum = data.drum
      voice.pos = 0
      voice.every = data.type === 'repeat' ? data.every : 0
      voice.left = voice.every
      this.port.postMessage({ type: 'onset', frame: currentFrame, pitch: data.pitch })
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
    const count = Atomics.load(sab, 0)
    if (count <= 0) return
    const take = Math.min(count, 8)
    for (let i = 0; i < take; i++) {
      const base = 1 + i * 4
      this.take({
        type: Atomics.load(sab, base) === 2 ? 'repeat' : Atomics.load(sab, base) === 0 ? 'off' : 'on',
        pitch: Atomics.load(sab, base + 1),
        velocity: Atomics.load(sab, base + 2) / 1000,
        drum: Atomics.load(sab, base + 3),
        every: 0,
      })
    }
    Atomics.store(sab, 0, 0)
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
            voice.left = voice.every
            voice.env = 1
            voice.pos = 0
            voice.phase = 0
          }
        }
        if (voice.drum >= 0 && this.drums[voice.drum]) {
          const buffer = this.drums[voice.drum]
          if (voice.pos < buffer.length) {
            sample += buffer[voice.pos] * voice.vel
            voice.pos += 1
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
