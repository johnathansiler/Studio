/**
 * Audio-thread clock for the transport scheduler.
 * The main thread only refills a look-ahead queue. This processor keeps asking
 * even while a click, sheet, or scroll is blocking timers.
 */
class TransportClock extends AudioWorkletProcessor {
  constructor() {
    super()
    this.left = 0
    this.every = 2048
  }

  process(_inputs, outputs) {
    const block = outputs[0]?.[0]?.length || 128
    this.left -= block
    if (this.left <= 0) {
      this.left = this.every
      this.port.postMessage({ type: 'wake' })
    }
    return true
  }
}

registerProcessor('cueharbor-transport', TransportClock)
