class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requested = options.processorOptions?.frameSize || 480
    this.frameSize = requested
    this.buf = new Float32Array(this.frameSize)
    this.filled = 0
    this.startFrame = 0
    this.active = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'start') {
        this.active = true
        this.filled = 0
      } else if (event.data?.type === 'stop') {
        this.active = false
        this.filled = 0
      } else if (event.data?.type === 'size') {
        this.frameSize = event.data.frameSize
        this.buf = new Float32Array(this.frameSize)
        this.filled = 0
      }
    }
  }

  process(inputs) {
    if (!this.active) return true
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let index = 0
    while (index < channel.length) {
      if (this.filled === 0) this.startFrame = currentFrame + index
      const n = Math.min(channel.length - index, this.frameSize - this.filled)
      this.buf.set(channel.subarray(index, index + n), this.filled)
      this.filled += n
      index += n
      if (this.filled === this.frameSize) {
        const copy = this.buf.slice(0)
        const frame = this.startFrame
        this.filled = 0
        this.buf = new Float32Array(this.frameSize)
        this.port.postMessage({ type: 'frame', frame, samples: copy }, [copy.buffer])
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTapProcessor)
