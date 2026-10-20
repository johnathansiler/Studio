class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.active = false
    this.pendingL = []
    this.pendingR = []
    this.batch = 0
    this.startFrame = 0
    this.haveStart = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'start') {
        this.active = true
        this.pendingL = []
        this.pendingR = []
        this.batch = 0
        this.haveStart = false
      } else if (event.data?.type === 'stop') {
        this.flush(true)
        this.active = false
      }
    }
  }

  flush(final) {
    if (!this.pendingL.length) {
      if (final) this.port.postMessage({ type: 'stopped' })
      return
    }
    const n = this.pendingL.reduce((sum, chunk) => sum + chunk.length, 0)
    const left = new Float32Array(n)
    let offset = 0
    for (const chunk of this.pendingL) {
      left.set(chunk, offset)
      offset += chunk.length
    }
    let right = null
    if (this.pendingR.length) {
      right = new Float32Array(n)
      offset = 0
      for (const chunk of this.pendingR) {
        if (chunk) {
          right.set(chunk, offset)
          offset += chunk.length
        }
      }
    }
    const transfer = right ? [left.buffer, right.buffer] : [left.buffer]
    this.port.postMessage({ type: 'chunk', frame: this.startFrame, left, right, final }, transfer)
    this.pendingL = []
    this.pendingR = []
    this.haveStart = false
  }

  process(inputs) {
    if (!this.active) return true
    const input = inputs[0]
    if (!input || !input[0] || !input[0].length) return true
    if (!this.haveStart) {
      this.startFrame = currentFrame
      this.haveStart = true
    }
    this.pendingL.push(new Float32Array(input[0]))
    this.pendingR.push(input[1] ? new Float32Array(input[1]) : null)
    this.batch += 1
    if (this.batch >= 8) {
      this.flush(false)
      this.batch = 0
    }
    return true
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
