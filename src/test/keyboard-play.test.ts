import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import {
  claimComputerKey,
  keyboardPitch,
  keyboardTarget,
  readKeyboardEnabled,
  writeKeyboardEnabled,
  KEYBOARD_KEY,
} from '../model/keyboardPlay'
import { createEmptyProject } from '../model/types'
import { typingTarget } from '../state/history'
import { ProjectStore } from '../state/store'
import { TransportBar } from '../ui/TransportBar'
import { KeyboardDock, playKeyboardNote } from '../ui/KeyboardDock'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/premium.css'].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

describe('computer keyboard', () => {
  it('plays the selected or armed instrument and ignores a second press', () => {
    const tracks = [
      { id: 'audio', type: 'audio' as const, armed: true },
      { id: 'keys', type: 'midi' as const, armed: false },
      { id: 'bass', type: 'midi' as const, armed: true },
    ]
    expect(keyboardTarget(tracks, 'keys')).toBe('keys')
    expect(keyboardTarget(tracks, 'audio')).toBe('bass')
    expect(keyboardTarget([{ id: 'pad', type: 'midi', armed: false }], null)).toBe('pad')
    expect(keyboardPitch(60, 0)).toBe(60)
    expect(keyboardPitch(60, 1)).toBe(72)
    expect(keyboardPitch(60, -1)).toBe(48)

    const note = { enabled: true, typing: false, meta: false, alt: false, repeat: false, held: false, code: 'KeyA', key: 'a' }
    expect(claimComputerKey(note)).toBe('note')
    expect(claimComputerKey({ ...note, held: true })).toBe('repeat')
    expect(claimComputerKey({ ...note, repeat: true })).toBe('repeat')
    expect(claimComputerKey({ ...note, enabled: false })).toBeNull()
    expect(claimComputerKey({ ...note, typing: true })).toBeNull()
    expect(claimComputerKey({ ...note, meta: true, key: 'z', code: 'KeyZ' })).toBeNull()
    expect(claimComputerKey({ ...note, key: 'z', code: 'KeyZ' })).toBe('octave-down')
    expect(claimComputerKey({ ...note, key: 'x', code: 'KeyX' })).toBe('octave-up')
    expect(claimComputerKey({ ...note, key: ' ', code: 'Space' })).toBeNull()
    expect(typingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(typingTarget({ tagName: 'DIV' })).toBe(false)
  })

  it('remembers the toggle and routes a note through the live instrument path', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
    }
    expect(readKeyboardEnabled(storage)).toBe(false)
    writeKeyboardEnabled(true, storage)
    expect(memory.get(KEYBOARD_KEY)).toBe('on')
    expect(readKeyboardEnabled(storage)).toBe(true)
    const store = new ProjectStore(createEmptyProject())
    store.keyboardMidi = false
    store.setKeyboardMidi(true)
    expect(store.keyboardMidi).toBe(true)
    const played: string[] = []
    const engine = {
      unlock() { played.push('unlock') },
      playThrough(id: string, pitch: number) { played.push(`${id}:${pitch}`) },
      liveNoteOn() { played.push('live') },
    } as unknown as AudioEngine
    const midi = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(midi.id)
    playKeyboardNote(store, engine, 64, 0.8)
    expect(played[0]).toBe(`${midi.id}:64`)
  })

  it('shows a beveled Keyboard button on the transport for every screen', () => {
    const store = new ProjectStore(createEmptyProject())
    store.keyboardMidi = true
    const engine = {
      unlock() {},
      positionSamples: 0,
      status: 'stopped',
      subscribe: () => () => undefined,
    } as unknown as AudioEngine
    const html = renderToStaticMarkup(createElement(TransportBar, {
      store,
      engine,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    expect(html).toContain('keyboard-toggle on')
    expect(html).toContain('>Keyboard<')
    expect(html).toContain('aria-pressed="true"')
    store.keyboardMidi = false
    const off = renderToStaticMarkup(createElement(TransportBar, {
      store,
      engine,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    expect(off).toContain('keyboard-toggle')
    expect(off).toContain('aria-pressed="false"')
  })
})

describe('keyboard dock screenshot', () => {
  it('shows the toggle on and the pad keyboard docked at the bottom', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    store.keyboardMidi = true
    const engine = {
      unlock() {},
      positionSamples: 0,
      status: 'stopped',
      subscribe: () => () => undefined,
    } as unknown as AudioEngine
    const dock = renderToStaticMarkup(createElement(KeyboardDock, { store, engine }))
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.setContent(`<!doctype html>
<html>
<head><style>
  html, body { margin: 0; height: 100%; background: #0e1512; }
  ${css}
  .shell { height: 800px; --accent: #c45b73; --accent-ink: #1a0c10; }
</style></head>
<body>
<div class="shell studio keys-open" data-form="desk">
  <header class="topbar"><div class="brand"><h1>CueHarbor</h1></div></header>
  <div class="transport">
    <div class="t-buttons">
      <button type="button" class="keyboard-toggle on" aria-pressed="true"><svg width="16" height="16"></svg><span>Keyboard</span></button>
    </div>
  </div>
  <div class="tool-slot"></div>
  <div class="workspace"><div class="arrange" style="background:#121a16"></div></div>
  ${dock}
</div>
</body></html>`, { waitUntil: 'load' })
      const box = await page.evaluate(() => {
        const shell = document.querySelector('.shell')!.getBoundingClientRect()
        const dockNode = document.querySelector('.keyboard-dock')!.getBoundingClientRect()
        const work = document.querySelector('.workspace')!.getBoundingClientRect()
        const button = document.querySelector('.keyboard-toggle')!.getBoundingClientRect()
        const pad = document.querySelector('.mini-pad.natural') as HTMLElement
        const sharp = document.querySelector('.mini-pad.sharp') as HTMLElement
        const down = [...document.querySelectorAll('.keyboard-octave button')].find((node) => node.textContent === 'Octave Down') as HTMLElement
        const style = getComputedStyle(pad)
        const accent = getComputedStyle(document.querySelector('.shell')!).getPropertyValue('--accent').trim()
        return {
          dockTop: dockNode.top,
          workBottom: work.bottom,
          shellBottom: shell.bottom,
          dockBottom: dockNode.bottom,
          buttonWidth: button.width,
          buttonHeight: button.height,
          label: document.querySelector('.keyboard-toggle span')!.textContent,
          octave: document.querySelector('.keyboard-octave span')!.textContent,
          naturals: document.querySelectorAll('.mini-pad.natural').length,
          sharps: document.querySelectorAll('.mini-pad.sharp').length,
          padHeight: pad.getBoundingClientRect().height,
          sharpHeight: sharp.getBoundingClientRect().height,
          downHeight: down.getBoundingClientRect().height,
          downBottom: down.getBoundingClientRect().bottom,
          padTop: pad.getBoundingClientRect().top,
          sharpTop: sharp.getBoundingClientRect().top,
          downLabel: down.textContent,
          border: style.borderTopColor,
          accent,
          background: style.backgroundColor,
        }
      })
      expect(box.label).toBe('Keyboard')
      expect(box.buttonWidth).toBeGreaterThan(80)
      expect(box.buttonHeight).toBeGreaterThanOrEqual(40)
      expect(box.octave).toBe('C3')
      expect(box.naturals).toBe(7)
      expect(box.sharps).toBe(5)
      expect(box.padHeight).toBeGreaterThanOrEqual(40)
      expect(box.sharpHeight).toBeGreaterThanOrEqual(40)
      expect(box.downHeight).toBeGreaterThanOrEqual(40)
      expect(box.downLabel).toBe('Octave Down')
      expect(box.downBottom).toBeLessThanOrEqual(box.sharpTop + 1)
      expect(box.downBottom).toBeLessThanOrEqual(box.padTop + 1)
      expect(box.accent).toBe('#c45b73')
      expect(box.background).not.toBe('rgb(115, 196, 143)')
      expect(box.border).not.toBe('rgb(115, 196, 143)')
      expect(box.dockTop).toBeGreaterThanOrEqual(box.workBottom - 1)
      expect(box.dockBottom).toBeLessThanOrEqual(box.shellBottom + 1)
      await page.screenshot({ path: '/opt/cursor/artifacts/keyboard-desktop.png' })
      await page.close()
    } finally {
      await browser.close()
    }
  })
})
