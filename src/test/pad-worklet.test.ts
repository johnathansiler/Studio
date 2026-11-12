import { describe, expect, it } from 'vitest'
import { PadGraph } from '../audio/voices/live'
import type { PadPlan, SlotPlan } from '../audio/voices/program'

/** The ScriptProcessor this worklet replaces pulled 256 frames. The audio thread quantum is 128. */
const SCRIPT_BLOCK = 256
const WORKLET_QUANTUM = 128
const RATE = 48000

function sine(length: number, freq: number, amp: number) {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * amp
  return data
}

function slot(partial: Partial<SlotPlan> & Pick<SlotPlan, 'pitch' | 'sampleId'>): SlotPlan {
  return {
    slot: 0,
    start: 0,
    end: 4800,
    semis: 0,
    cents: 0,
    mode: 'vinyl',
    chopSemi: 0,
    voiceTune: 0,
    filterAmount: 1,
    highpass: 0,
    lowpass: 20000,
    choke: 0,
    reverse: false,
    hold: false,
    swing: 0,
    level: 1,
    pan: 0,
    loop: false,
    busId: '',
    fadeIn: 32,
    vintage: { bitDepth: 0, sampleRate: 0, wow: 0, flutter: 0, noise: 0, crackle: 0, lowpass: 0 },
    ...partial,
  }
}

function plan(): PadPlan {
  const samples = sine(4800, 220, 0.8)
  return {
    samples: [{ id: 1, key: 'tone', samples, sampleRate: RATE }],
    slots: [slot({ pitch: 36, sampleId: 1, end: samples.length })],
  }
}

/** Same render the pad worklet runs for one quantum. */
function renderBlock(graph: PadGraph, time: number, frames: number) {
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  graph.renderInto(time, left, right)
  return { left, right }
}

function peak(data: Float32Array) {
  let max = 0
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]))
  return max
}

describe('pad worklet render', () => {
  it('plays an audible stereo hit inside one quantum, with no glitch', () => {
    const graph = new PadGraph(RATE, undefined, { wasm: false })
    graph.arm(plan())
    expect(graph.hit(36, 0.9, 0)).toBe(true)
    const blocks = Array.from({ length: 8 }, (_, index) => renderBlock(graph, (index * WORKLET_QUANTUM) / RATE, WORKLET_QUANTUM))
    const left = new Float32Array(blocks.length * WORKLET_QUANTUM)
    const right = new Float32Array(blocks.length * WORKLET_QUANTUM)
    blocks.forEach((block, index) => {
      left.set(block.left, index * WORKLET_QUANTUM)
      right.set(block.right, index * WORKLET_QUANTUM)
    })
    let onset = -1
    for (let i = 0; i < left.length; i++) {
      if (Math.abs(left[i]) > 0.02 || Math.abs(right[i]) > 0.02) {
        onset = i
        break
      }
    }
    expect(onset).toBeGreaterThanOrEqual(0)
    expect(onset).toBeLessThan(WORKLET_QUANTUM)
    expect(onset).toBeLessThan(SCRIPT_BLOCK)
    expect(peak(left)).toBeGreaterThan(0.05)
    expect(peak(right)).toBeGreaterThan(0.05)
    const ratio = peak(left) / peak(right)
    expect(ratio).toBeGreaterThan(0.5)
    expect(ratio).toBeLessThan(2)
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true)
      expect(Number.isFinite(right[i])).toBe(true)
      expect(Math.abs(left[i])).toBeLessThanOrEqual(1)
      expect(Math.abs(right[i])).toBeLessThanOrEqual(1)
    }
    for (let i = 96; i < left.length; i++) {
      expect(Math.abs(left[i] - left[i - 1])).toBeLessThan(0.25)
      expect(Math.abs(right[i] - right[i - 1])).toBeLessThan(0.25)
    }
  })
})
