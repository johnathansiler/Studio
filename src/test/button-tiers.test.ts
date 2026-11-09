import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../ui/buttonTiers.css', import.meta.url), 'utf8')
const tray = readFileSync(new URL('../ui/buttonTray.css', import.meta.url), 'utf8')
const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

describe('button tiers', () => {
  it('defines primary, secondary, and quiet tokens in the shared sheet', () => {
    expect(css).toContain('--btn-primary-bg')
    expect(css).toContain('--btn-secondary-bg')
    expect(css).toContain('--btn-quiet-bg')
    expect(css).toContain('--btn-toggle-mute-bg')
    expect(css).toContain('--btn-toggle-solo-bg')
    expect(css).toContain('--btn-toggle-arm-bg')
    expect(css).toContain('--btn-min: 40px')
    expect(css).toContain('--btn-bevel:')
    expect(css).toContain('.btn-primary')
    expect(css).toContain('.btn-secondary')
    expect(css).toContain('.btn-quiet')
    expect(css).toContain('.btn-tertiary')
  })

  it('keeps Play, Record, and Add Track primary and the loud utilities quiet', () => {
    expect(css).toContain('.shell .add-track-btn')
    expect(css).toContain('.shell .transport .t-btn.play')
    expect(css).toContain('.shell .transport .t-btn.rec')
    expect(css).toContain('.shell .mpc-keyboard')
    expect(css).toContain('.shell .mpc-close')
    expect(css).toContain('.shell .pl-head .beat-open')
    expect(css).toContain('.shell .pl-head .piano-open')
    expect(css).toContain('.shell .transport .t-btn.reset')
    expect(css).toContain('.shell .mini.on-m')
    expect(css).toContain('.shell .mini.on-s')
    expect(css).toContain('.shell .mini.on-r')
    expect(css).toContain('.shell .t-btn.loop.on')
  })

  it('loads after the premium sheet so the tiers win', () => {
    const premium = main.indexOf("import './ui/premium.css'")
    const stage = main.indexOf("import './ui/pluginStage.css'")
    const tiers = main.indexOf("import './ui/buttonTiers.css'")
    const trayImport = main.indexOf("import './ui/buttonTray.css'")
    expect(premium).toBeGreaterThan(-1)
    expect(stage).toBeGreaterThan(premium)
    expect(tiers).toBeGreaterThan(stage)
    expect(trayImport).toBeGreaterThan(tiers)
  })

  it('shares one recessed tray and one rounded-rectangle button', () => {
    expect(tray).toContain('--tray-bg')
    expect(tray).toContain('--tray-gap: 5px')
    expect(tray).toContain('--tray-btn-radius: 12px')
    expect(tray).toContain('.btn-tray')
    expect(tray).toContain('.btn-tray-equal')
    expect(tray).not.toContain('border-radius: 999px')
    expect(css).toContain('--btn-radius: 12px')
    expect(css).not.toContain('999px')
  })
})
