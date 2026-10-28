import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../audio/plugins/catalog'
import { decaySteps, driveShape, eqGainAt, transferGain } from '../ui/faces/curves'
import { FACE_THEMES } from '../ui/faces/themes'
import { PluginFace } from '../ui/faces/PluginFace'
import { clampUnit, formatValue, keyboardNotes, valueFromDrag } from '../ui/kit/controls'

describe('face kit', () => {
  it('gives every insert except the in-flight tuner its own badge and accent', () => {
    const accents = new Set<string>()
    for (const plugin of CATALOG) {
      if (plugin.id === 'tune') continue
      const theme = FACE_THEMES[plugin.id]
      expect(theme, plugin.id).toBeTruthy()
      expect(theme.badge.length).toBeGreaterThan(1)
      accents.add(theme.accent)
    }
    expect(accents.size).toBeGreaterThan(12)
  })

  it('draws a curve that follows gain and a compressor that holds below the threshold', () => {
    expect(eqGainAt(1500, { midF: 1500, midG: 6, midQ: 1 })).toBeGreaterThan(4)
    expect(eqGainAt(40, { midF: 1500, midG: 6, midQ: 1 })).toBeLessThan(1)
    expect(transferGain(-40, -18, 4, 0)).toBe(-40)
    expect(transferGain(0, -18, 4, 0)).toBeCloseTo(-18 + 18 / 4)
    expect(decaySteps(0.8, 0.6)[0]).toBeGreaterThan(decaySteps(0.8, 0.6).at(-1)!)
    expect(Math.max(...driveShape(0.9).map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('resets from a drag delta and renders a keyboard inside a faceplate', () => {
    expect(clampUnit(5, 0, 10)).toBe(0.5)
    expect(valueFromDrag(0, -90, 0, 1, false)).toBeCloseTo(1)
    expect(formatValue(440, 'Hz')).toBe('440 Hz')
    expect(keyboardNotes(2)).toHaveLength(15)
    const html = renderToStaticMarkup(createElement(PluginFace, {
      pluginId: 'eq',
      params: [{ id: 'midG', name: 'Mid', min: -18, max: 12, default: 0, unit: 'dB', automatable: true }],
      values: { midG: 3 },
      onChange: () => undefined,
    }))
    expect(html).toContain('Curve')
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-label="Mid"')
    const keys = renderToStaticMarkup(createElement(PluginFace, {
      pluginId: 'sampler',
      params: [],
      values: {},
      keyboard: true,
      showParams: false,
      onChange: () => undefined,
    }))
    expect(keys).toContain('Pad')
    expect(keys).toContain('aria-label="Keyboard"')
  })
})