class PingProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.lastPeak = -100000
    this.armed = true
    this.port.onmessage = (event) => {
      if (event.data?.type === 'arm') this.armed = true
      if (event.data?.type === 'disarm') this.armed = false
    }
  }

  process(inputs) {
    if (!this.armed) return true
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let peak = 0
    let peakIndex = 0
    for (let i = 0; i < channel.length; i++) {
      const mag = Math.abs(channel[i])
      if (mag > peak) {
        peak = mag
        peakIndex = i
      }
    }
    if (peak > 0.35 && currentFrame - this.lastPeak > sampleRate * 0.12) {
      this.lastPeak = currentFrame + peakIndex
      this.port.postMessage({ type: 'peak', frame: currentFrame + peakIndex, mag: peak })
    }
    return true
  }
}

registerProcessor('ping-processor', PingProcessor)
