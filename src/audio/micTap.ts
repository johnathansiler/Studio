/**
 * Microphone frames.
 * The recorder worklet runs on the audio thread. ScriptProcessor is only for
 * browsers that cannot construct an AudioWorklet.
 */

const RECORDER_URL = '/worklets/recorder.js'

export function interactiveAudioContext(): AudioContext {
  try {
    return new AudioContext({ latencyHint: 'interactive' })
  } catch {
    return new AudioContext()
  }
}

export interface MicTap {
  sampleRate: number
  /** Deliver a copy of each mono block. The returned function stops delivery. */
  start(onFrame: (frame: Float32Array) => void): () => void
  close(): void
}

/** Worklet when the context can host one, otherwise a script processor. */
export async function openMicTap(ctx: AudioContext, stream: MediaStream, channel: number | null): Promise<MicTap | null> {
  const worklet = await openWorkletTap(ctx, stream, channel)
  if (worklet) return worklet
  return openScriptTap(ctx, stream, channel)
}

async function openWorkletTap(ctx: AudioContext, stream: MediaStream, channel: number | null): Promise<MicTap | null> {
  if (typeof AudioWorkletNode !== 'function') return null
  const add = ctx.audioWorklet?.addModule
  if (typeof add !== 'function') return null
  try {
    await add.call(ctx.audioWorklet, RECORDER_URL)
  } catch {
    /* Already registered on this context, or the module will fail at construction. */
  }
  let node: AudioWorkletNode
  try {
    node = new AudioWorkletNode(ctx, 'recorder-processor')
  } catch {
    return null
  }
  const src = ctx.createMediaStreamSource(stream)
  const silent = ctx.createGain()
  silent.gain.value = 0
  let splitter: ChannelSplitterNode | null = null
  try {
    if (channel != null && typeof ctx.createChannelSplitter === 'function') {
      splitter = ctx.createChannelSplitter(channel + 1)
      src.connect(splitter)
      splitter.connect(node, channel, 0)
    } else src.connect(node)
    node.connect(silent)
    silent.connect(ctx.destination)
  } catch {
    try { node.disconnect() } catch { /* not connected */ }
    return null
  }
  let handler: ((frame: Float32Array) => void) | null = null
  node.port.onmessage = (event: MessageEvent<{ type?: string; left?: Float32Array }>) => {
    const left = event.data?.left
    if (!handler || event.data?.type !== 'chunk' || !(left instanceof Float32Array)) return
    handler(Float32Array.from(left))
  }
  try { node.port.postMessage({ type: 'start' }) } catch { /* the port closed */ }
  return {
    sampleRate: ctx.sampleRate,
    start(onFrame) {
      handler = onFrame
      return () => { handler = null }
    },
    close() {
      handler = null
      try { node.port.postMessage({ type: 'stop' }) } catch { /* already stopped */ }
      try { node.disconnect() } catch { /* already stopped */ }
      try { splitter?.disconnect() } catch { /* already stopped */ }
      try { src.disconnect() } catch { /* already stopped */ }
      try { silent.disconnect() } catch { /* already stopped */ }
    },
  }
}

function openScriptTap(ctx: AudioContext, stream: MediaStream, channel: number | null): MicTap | null {
  if (typeof ctx.createScriptProcessor !== 'function') return null
  let proc: ScriptProcessorNode
  try {
    proc = ctx.createScriptProcessor(2048, 1, 1)
  } catch {
    return null
  }
  const src = ctx.createMediaStreamSource(stream)
  const silent = ctx.createGain()
  silent.gain.value = 0
  let splitter: ChannelSplitterNode | null = null
  try {
    if (channel != null && typeof ctx.createChannelSplitter === 'function') {
      splitter = ctx.createChannelSplitter(channel + 1)
      src.connect(splitter)
      splitter.connect(proc, channel, 0)
    } else src.connect(proc)
    proc.connect(silent)
    silent.connect(ctx.destination)
  } catch {
    try { proc.disconnect() } catch { /* not connected */ }
    return null
  }
  let handler: ((frame: Float32Array) => void) | null = null
  proc.onaudioprocess = (event) => {
    if (!handler) return
    handler(Float32Array.from(event.inputBuffer.getChannelData(0)))
  }
  return {
    sampleRate: ctx.sampleRate,
    start(onFrame) {
      handler = onFrame
      return () => { handler = null }
    },
    close() {
      handler = null
      try { proc.disconnect() } catch { /* already stopped */ }
      try { splitter?.disconnect() } catch { /* already stopped */ }
      try { src.disconnect() } catch { /* already stopped */ }
      try { silent.disconnect() } catch { /* already stopped */ }
    },
  }
}
