import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MainMenu } from '../ui/MainMenu'
import { visibleMenu } from '../ui/chrome'

const desk = visibleMenu({ phone: false, session: false, dockBottom: false, hardwareMidi: true })

function render(pressed: (action: string) => boolean = () => false) {
  return renderToStaticMarkup(createElement(MainMenu, {
    items: desk,
    pressed,
    disabled: (action) => action === 'signature',
    onAction: () => undefined,
    signature: '4/4',
    onSignature: () => undefined,
    latencyHint: 'interactive',
    latencyReadout: 'Base 12.0 ms. Output 8.0 ms.',
    onLatency: () => undefined,
  }))
}

describe('main menu rows', () => {
  it('renders full-width text rows, section labels, and settings values', () => {
    const html = render()
    expect(html).not.toContain('btn-tray')
    expect(html).not.toContain('menu-sig')
    expect(html).toContain('class="menu-heading"')
    for (const label of ['Project', 'Edit', 'Tools', 'Settings']) expect(html).toContain(`>${label}<`)
    for (const item of desk) {
      expect(html).toContain(`data-menu-action="${item.action}"`)
      expect(html).toContain(item.label)
      expect(html).toContain(item.hint)
    }
    expect(html).toContain('data-menu-action="latency"')
    expect(html).toContain('>Lowest<')
    expect(html).toContain('>4/4<')
    expect(html).toContain('Base 12.0 ms. Output 8.0 ms.')
    expect(html).toContain('class="menu-chevron"')
    expect(html).toContain('aria-label="Time. Beats in each bar."')
    expect(html).toContain('disabled=""')
    expect(html.match(/class="menu-row( |")/g)?.length).toBe(desk.length + 1)
    expect(html).not.toContain('menu-check')
  })

  it('marks the active tool with a check and leaves the others plain', () => {
    const html = render((action) => action === 'box')
    const row = (action: string) => {
      const at = html.indexOf(`data-menu-action="${action}"`)
      const start = html.lastIndexOf('<button', at)
      return html.slice(start, html.indexOf('</button>', at))
    }
    const box = row('box')
    expect(box).toContain('aria-pressed="true"')
    expect(box).toContain('menu-check')
    const erase = row('erase')
    expect(erase).not.toContain('aria-pressed="true"')
    expect(erase).not.toContain('menu-check')
  })

  it('keeps the list styles ahead of the tray chips', () => {
    const css = readFileSync(new URL('../ui/mainMenu.css', import.meta.url), 'utf8')
    const tray = readFileSync(new URL('../ui/buttonTray.css', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('text-transform: uppercase')
    expect(css).toContain('border-top: 1px solid rgba(255, 255, 255, 0.08)')
    expect(css).toContain('border-radius: 0 !important')
    expect(css).toContain('rgba(115, 196, 143, 0.16)')
    expect(css).not.toMatch(/border-radius:\s*(?:[1-9]|[1-9]\d|var\(--tray)/)
    expect(tray).not.toContain('#shell-menu button')
    expect(tray).not.toContain('#shell-menu .menu-group')
    expect(main.indexOf("import './ui/buttonTray.css'")).toBeLessThan(main.indexOf("import './ui/mainMenu.css'"))
  })
})
