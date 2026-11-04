import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { descriptor } from '../audio/plugins/catalog'
import { gainToDb } from '../model/time'
import { Fader, Knob, TouchSlider } from '../ui/kit/controls'
import { FADER_0_DB, PAN_CENTER, SEND_LEVEL, controlDefault } from '../ui/paramDefaults'

describe('parameter defaults', () => {
  it('resets a mixer fader to 0 dB and pan to center', () => {
    expect(gainToDb(FADER_0_DB)).toBe('0.0 dB')
    expect(controlDefault({
      label: 'Master volume. How loud the whole mix is.',
      className: 'touch-slider vertical volume',
      min: 0,
      max: 1.25,
      fallback: 0.9,
    })).toBe(FADER_0_DB)
    expect(controlDefault({
      label: 'Kick Vol. How loud this row is.',
      min: 0,
      max: 1,
      fallback: 0.5,
    })).toBe(FADER_0_DB)
    expect(controlDefault({
      label: 'Vocal pan. Left or right.',
      className: 'pan-knob',
      param: 'pan',
      target: 'pan',
      min: -1,
      max: 1,
      fallback: 0.4,
    })).toBe(PAN_CENTER)
  })

  it('keeps a declared knob default and fills the ones that were missing', () => {
    const retune = descriptor('tune')?.params.find((param) => param.id === 'retune')
    expect(retune).toBeTruthy()
    expect(controlDefault({
      label: 'Retune',
      min: retune!.min,
      max: retune!.max,
      fallback: retune!.default,
    })).toBe(retune!.default)
    expect(controlDefault({ label: 'Auto-Tune Retune', min: retune!.min, max: retune!.max })).toBe(retune!.default)
    expect(controlDefault({ label: 'Pad tune', min: -12, max: 12 })).toBe(0)
    expect(controlDefault({ label: 'Filter', min: 0, max: 1 })).toBe(1)
    expect(controlDefault({ label: 'Vintage', min: 0, max: 1 })).toBe(0)
    expect(controlDefault({ label: 'Pad volume', min: 0, max: 1 })).toBe(0.8)
    expect(controlDefault({ label: 'Hall send level', min: 0, max: 1 })).toBe(SEND_LEVEL)
    expect(controlDefault({ label: 'Drum send A', min: 0, max: 1 })).toBe(SEND_LEVEL)
    expect(controlDefault({ label: 'Send', min: 0, max: 1 })).toBe(0)
    expect(controlDefault({ label: 'Scaler root', min: 0, max: 11 })).toBe(0)
    expect(controlDefault({ label: 'Mystery', min: 0, max: 1 })).toBeNull()
    expect(controlDefault({
      label: 'Master volume',
      min: 0,
      max: 1.25,
      fallback: 0.9,
      declared: 0.5,
    })).toBe(0.5)
  })
})

describe('shared controls', () => {
  it('renders a knob, a fader, and a slider with the name a double tap can read', () => {
    const knob = renderToStaticMarkup(createElement(Knob, {
      label: 'Cutoff',
      min: 40,
      max: 16000,
      value: 2000,
      fallback: 1400,
      onChange: () => undefined,
    }))
    const fader = renderToStaticMarkup(createElement(Fader, {
      label: 'Level',
      min: 0,
      max: 1,
      value: 0.4,
      unit: 'dB',
      fallback: 0,
      onChange: () => undefined,
    }))
    const slider = renderToStaticMarkup(createElement(TouchSlider, {
      label: 'Master volume',
      className: 'volume',
      min: 0,
      max: 1.25,
      value: 0.9,
      onChange: () => undefined,
    }))
    expect(knob).toContain('role="slider"')
    expect(knob).toContain('aria-label="Cutoff"')
    expect(fader).toContain('aria-label="Level"')
    expect(slider).toContain('aria-label="Master volume"')
    expect(slider).toContain('volume')
  })
})
