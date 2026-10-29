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
import { playKeyboardNote } from '../ui/KeyboardDock'

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

  it('shows a beveled Keyboard button on the desktop transport', () => {
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
      desk: true,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    expect(html).toContain('keyboard-toggle on')
    expect(html).toContain('>Keyboard<')
    expect(html).toContain('aria-pressed="true"')
    const hidden = renderToStaticMarkup(createElement(TransportBar, {
      store,
      engine,
      desk: false,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    expect(hidden).not.toContain('keyboard-toggle')
  })
})

describe('keyboard dock screenshot', () => {
  it('shows the toggle on and the piano docked at the bottom', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.setContent(`<!doctype html>
<html>
<head><style>
  html, body { margin: 0; height: 100%; background: #0e1512; }
  ${css}
  .shell { height: 800px; }
</style></head>
<body>
<div class="shell studio desk-keys" data-form="desk">
  <header class="topbar"><div class="brand"><h1>CueHarbor</h1></div></header>
  <div class="transport">
    <div class="t-buttons">
      <button type="button" class="keyboard-toggle on" aria-pressed="true"><svg width="16" height="16"></svg><span>Keyboard</span></button>
    </div>
  </div>
  <div class="tool-slot"></div>
  <div class="workspace"><div class="arrange" style="background:#121a16"></div></div>
  <div class="keyboard-dock" data-keyboard-dock="open">
    <div class="keyboard-octave" role="group" aria-label="Octave">
      <button type="button">Z</button>
      <span>C4</span>
      <button type="button">X</button>
    </div>
    <div class="keyboard-keys" role="group" aria-label="Piano keyboard">
      ${Array.from({ length: 14 }, () => '<div class="slot"><button type="button" class="white"></button></div>').join('')}
    </div>
  </div>
</div>
</body></html>`, { waitUntil: 'load' })
      const box = await page.evaluate(() => {
        const shell = document.querySelector('.shell')!.getBoundingClientRect()
        const dock = document.querySelector('.keyboard-dock')!.getBoundingClientRect()
        const work = document.querySelector('.workspace')!.getBoundingClientRect()
        const button = document.querySelector('.keyboard-toggle')!.getBoundingClientRect()
        const label = document.querySelector('.keyboard-toggle span')!.textContent
        return {
          dockTop: dock.top,
          workBottom: work.bottom,
          shellBottom: shell.bottom,
          dockBottom: dock.bottom,
          buttonWidth: button.width,
          label,
          octave: document.querySelector('.keyboard-octave span')!.textContent,
        }
      })
      expect(box.label).toBe('Keyboard')
      expect(box.buttonWidth).toBeGreaterThan(80)
      expect(box.octave).toBe('C4')
      expect(box.dockTop).toBeGreaterThanOrEqual(box.workBottom - 1)
      expect(box.dockBottom).toBeLessThanOrEqual(box.shellBottom + 1)
      await page.screenshot({ path: '/opt/cursor/artifacts/keyboard-desktop.png' })
      await page.close()
    } finally {
      await browser.close()
    }
  })
})
