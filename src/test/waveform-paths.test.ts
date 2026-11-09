import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPeakPyramid, peaksForSpan } from '../audio/peakPyramid'
import { previewPeaks } from '../storage/content'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** Files that show an audio waveform. Each one must call the shared Arrange painter. */
const WAVE_SURFACES = [
  'src/ui/waveformDraw.ts',
  'src/ui/WaveformView.tsx',
  'src/ui/SoundBrowser.tsx',
  'src/ui/ProjectSheet.tsx',
  'src/ui/PadScreen.tsx',
  'src/ui/PerformPop.tsx',
  'src/ui/KnockPop.tsx',
  'src/ui/ArrangeView.tsx',
  'src/ui/ChopDrawer.tsx',
  'src/ui/SamplerFace.tsx',
  'src/ui/SamplePanel.tsx',
  'src/ui/sessionDetail.tsx',
]

describe('one waveform renderer', () => {
  it('sends every waveform surface through the Arrange painter', () => {
    const ui = walk('src/ui')
    const offenders: string[] = []
    for (const file of ui) {
      if (file.endsWith('waveformDraw.ts')) continue
      const text = readFileSync(file, 'utf8')
      const shared = text.includes('paintWaveCanvas') || text.includes('drawWaveform') || text.includes('MiniWave') || text.includes('WaveformView')
      if (text.includes('waveformPeaks(')) offenders.push(`${file} still builds browser bar peaks`)
      if (text.includes('viewPeaks(')) offenders.push(`${file} still draws pad bars`)
      if (/function drawWave\(/.test(text) && !text.includes('paintWaveCanvas')) offenders.push(`${file} has a private drawWave`)
      if (/peaks\.forEach\(\(peak/.test(text)) offenders.push(`${file} fills one rectangle per peak`)
      if (text.includes('Math.max(12, peak')) offenders.push(`${file} draws CSS peak bars`)
      if (/samples\[index\]/.test(text) && /lineTo\(/.test(text) && !shared) offenders.push(`${file} strokes samples itself`)
    }
    expect(offenders).toEqual([])
    for (const file of WAVE_SURFACES) {
      const text = readFileSync(file, 'utf8')
      const shared = /paintWaveCanvas|drawWaveform|MiniWave|WaveformView/.test(text)
      expect(shared, file).toBe(true)
    }
    const defined = walk('src').filter((file) => /export function drawWaveform\(/.test(readFileSync(file, 'utf8')))
    expect(defined).toEqual(['src/ui/waveformDraw.ts'])
  })

  it('stores the same min/max pyramid Arrange paints', () => {
    const channel = new Float32Array(400)
    channel[10] = 0.5
    channel[200] = -1
    const stored = previewPeaks([channel], 32)
    const direct = peaksForSpan(buildPeakPyramid(channel), 0, channel.length, Math.min(32, channel.length))
    expect(stored).toEqual(direct)
    expect(stored.some((bin) => bin.min < 0)).toBe(true)
    expect(stored.some((bin) => bin.max > 0)).toBe(true)
  })
})
