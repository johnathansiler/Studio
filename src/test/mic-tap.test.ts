import { describe, expect, it } from 'vitest'
import { openMicTap } from '../audio/micTap'
import { openInputCapture } from '../audio/sample/slot'

function stream() {
  return {
    getAudioTracks: () => [{ readyState: 'live', stop() {} }],
  } as unknown as MediaStream
}

function scriptContext() {
  let scripts = 0
  const ctx = {
    sampleRate: 44100,
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      scripts += 1
      return { connect() {}, disconnect() {}, onaudioprocess: null }
    },
  }
  return { ctx, scripts: () => scripts }
}

describe('microphone tap', () => {
  it('uses a script processor only when AudioWorklet is missing', async () => {
    const { ctx, scripts } = scriptContext()
    const tap = await openMicTap(ctx as unknown as AudioContext, stream(), null)
    expect(tap).toBeTruthy()
    expect(scripts()).toBe(1)
    expect(tap?.sampleRate).toBe(44100)
    tap?.close()
  })

  it('records through the worklet when the browser has one', async () => {
    const { ctx, scripts } = scriptContext()
    const frames: Float32Array[] = []
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage() {},
    }
    const previous = globalThis.AudioWorkletNode
    class FakeWorklet {
      port = port
      connect() {}
      disconnect() {}
    }
    Object.assign(globalThis, { AudioWorkletNode: FakeWorklet })
    try {
      const heard = await openInputCapture({
        deviceId: '',
        stream: stream(),
        context: {
          ...ctx,
          audioWorklet: { addModule: async () => undefined },
        } as unknown as Parameters<typeof openInputCapture>[0]['context'],
        channel: null,
        request: async () => { throw new Error('unused') },
      })
      expect(scripts()).toBe(0)
      heard.source.start((frame) => frames.push(frame))
      port.onmessage?.({ data: { type: 'chunk', left: new Float32Array([0.25, -0.25]) } } as MessageEvent)
      expect(frames[0]?.[0]).toBeCloseTo(0.25)
      heard.close()
    } finally {
      if (previous) globalThis.AudioWorkletNode = previous
      else delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode
    }
  })
})
