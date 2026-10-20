class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.length = sampleRate * 3
    this.buffer = new Float32Array(this.length)
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'write') return
      const samples = event.data.samples
      const start = event.data.frame
      for (let i = 0; i < samples.length; i++) {
        const at = start + i
        if (at < currentFrame) continue
        if (at > currentFrame + this.length - 64) continue
        this.buffer[at % this.length] = samples[i]
      }
    }
  }

  process(_inputs, outputs) {
    const channels = outputs[0]
    if (!channels || !channels[0]) return true
    for (let i = 0; i < channels[0].length; i++) {
      const idx = (currentFrame + i) % this.length
      const sample = this.buffer[idx]
      this.buffer[idx] = 0
      for (let c = 0; c < channels.length; c++) channels[c][i] = sample
    }
    return true
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor)
