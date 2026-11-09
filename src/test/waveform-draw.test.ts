import { describe, expect, it } from 'vitest'
import { buildPeakPyramid } from '../audio/peakPyramid'
import { envelopeVertices, outlineColumns, waveColumns, WAVE_DPR_CAP, drawWaveform } from '../ui/waveformDraw'

describe('waveform columns', () => {
  it('uses one column per device pixel and caps the scale', () => {
    expect(waveColumns(100, 1)).toBe(100)
    expect(waveColumns(100, 3)).toBe(300)
    expect(waveColumns(100, 4)).toBe(100 * WAVE_DPR_CAP)
    expect(WAVE_DPR_CAP).toBe(3)
  })

  it('keeps each measured peak on its own column', () => {
    const bars = [{ min: -0.2, max: 0.2 }, { min: -1, max: 1 }, { min: 0, max: 0 }]
    const { top, bottom } = envelopeVertices(bars, 90, 40)
    expect(top.map((point) => point.x)).toEqual([15, 45, 75])
    expect(top[1].y).toBeLessThan(top[0].y)
    expect(top[1].y).toBeLessThan(top[2].y)
    expect(bottom[1].y).toBeGreaterThan(bottom[0].y)
    for (let index = 0; index < bars.length; index += 1) {
      expect(top[index].y).toBeLessThanOrEqual(bottom[index].y)
    }
  })

  it('keeps a transient that nearest-neighbor sampling would skip', () => {
    const outline = [
      { min: 0, max: 0.1 },
      { min: -1, max: 1 },
      { min: 0, max: 0.1 },
    ]
    const bars = outlineColumns(outline, 0, 3, 3, 2)
    expect(bars.some((bar) => bar.max === 1)).toBe(true)
    expect(bars.every((bar) => bar.max <= 1)).toBe(true)
  })

  it('fills an envelope instead of a rectangle per column', () => {
    const channel = new Float32Array(4000)
    channel[100] = 1
    channel[2200] = -1
    const pyramid = buildPeakPyramid(channel)
    const ops: string[] = []
    const ctx = {
      getTransform: () => ({ a: 2 }),
      clearRect() {},
      beginPath() { ops.push('begin') },
      moveTo() {},
      lineTo() { ops.push('line') },
      closePath() {},
      fill() { ops.push('fill') },
      stroke() { ops.push('stroke') },
      fillRect() { ops.push('rect') },
      arc() {},
      set strokeStyle(_value: string) {},
      set fillStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set lineJoin(_value: string) {},
      set lineCap(_value: string) {},
    } as unknown as CanvasRenderingContext2D
    drawWaveform(ctx, 80, 36, channel, pyramid, { start: 0, end: 20000 }, '#fff')
    expect(ops).toContain('fill')
    expect(ops.filter((op) => op === 'rect')).toHaveLength(0)
    expect(ops.filter((op) => op === 'line').length).toBeGreaterThan(8)
  })
})
