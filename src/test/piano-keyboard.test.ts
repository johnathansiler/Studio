import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { readKeyboardOctave, writeKeyboardOctave, keyboardStart } from '../model/keyboardPlay'
import { armKey, armSounded, releaseGesture, releaseKey, takeGroups } from '../model/keyboardRecord'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { commitKeyboardNotes, playKeyboardNote } from '../ui/KeyboardDock'
import { dismissKeyboard, isPianoHistory, markPianoHistory, presentKeyboard, type LandscapeHost } from '../ui/keyboardStage'
import { miniPads, padGridColumn } from '../ui/miniKeys'
import { MidiDock } from '../ui/MidiDock'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/midi-editors.css']
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  unlock() {},
  resume: async () => undefined,
  liveNoteOn() {},
  liveNoteOff() {},
  playThrough() {},
  releaseThrough() {},
  previewPitches() {},
} as unknown as AudioEngine

function host(patch: Partial<LandscapeHost> = {}) {
  const result: LandscapeHost & { locked: string[]; exited: number; entered: number } = {
    form: 'phone',
    portrait: true,
    fullscreenEnabled: true,
    fullscreenElement: null,
    entered: 0,
    exited: 0,
    locked: [],
    async requestFullscreen() { result.entered += 1 },
    async exitFullscreen() { result.exited += 1 },
    async lock(kind: 'landscape') { result.locked.push(kind) },
    unlock() {},
  }
  return Object.assign(result, patch)
}

describe('mini keyboard pads', () => {
  it('draws one octave of seven naturals and five sharps from C3', () => {
    const pads = miniPads(0)
    expect(keyboardStart(0)).toBe(48)
    expect(pads.naturals.map((pad) => pad.name)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'])
    expect(pads.naturals.map((pad) => pad.pitch)).toEqual([48, 50, 52, 53, 55, 57, 59])
    expect(pads.sharps.map((pad) => pad.name)).toEqual(['C♯', 'D♯', 'F♯', 'G♯', 'A♯'])
    expect(pads.sharps.map((pad) => pad.pitch)).toEqual([49, 51, 54, 56, 58])
    expect(padGridColumn(pads.naturals[0])).toBe('1 / span 2')
    expect(padGridColumn(pads.sharps[0])).toBe('2 / span 2')
    expect(padGridColumn(pads.sharps[2])).toBe('8 / span 2')
    expect(miniPads(1).naturals[0].pitch).toBe(60)
    expect(miniPads(-4).naturals[0].pitch).toBe(0)
    expect(miniPads(9).naturals[0].pitch).toBe(keyboardStart(5))
  })

  it('remembers the octave beside the open and closed choice', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
    }
    expect(readKeyboardOctave(storage)).toBe(0)
    writeKeyboardOctave(2, storage)
    expect(readKeyboardOctave(storage)).toBe(2)
    writeKeyboardOctave(40, storage)
    expect(readKeyboardOctave(storage)).toBe(5)
  })

  it('uses the accent token for pad outline and pressed fill', () => {
    const rule = css.slice(css.indexOf('.mini-pad {'), css.indexOf('.mini-pad.natural'))
    expect(rule).toContain('var(--accent)')
    expect(rule).toContain('var(--bg-0)')
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    const lit = css.slice(css.indexOf('.mini-pad.lit'), css.indexOf('.shell.phone .keyboard-dock'))
    expect(lit).toContain('background: var(--accent)')
    expect(lit).toContain('var(--glow)')
    expect(lit).not.toMatch(/teal|#0d9488|#14b8a6|#2dd4bf/i)
  })
})

describe('keyboard recording', () => {
  it('writes a held key into the open clip and a loose take like MIDI input', () => {
    const armed = armKey([], {
      token: 'ptr:1',
      trackId: 'keys',
      clipId: 'clip',
      clipStart: 4,
      pitch: 60,
      velocity: 0.8,
      startBeat: 5,
    })
    const released = releaseKey(armed, 'ptr:1', 6.5)
    expect(released.keys).toEqual([])
    expect(released.note).toMatchObject({ clipId: 'clip', pitch: 60, startBeat: 1, durationBeats: 1.5 })
    expect(releaseKey(released.keys, 'ptr:1', 8).note).toBeNull()

    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.preparePianoClip(track.id, 0)
    const clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId)!
    commitKeyboardNotes(store, [{
      trackId: track.id,
      clipId: clip.id,
      pitch: 64,
      startBeat: 1,
      durationBeats: 0.5,
      velocity: 0.7,
    }])
    expect(clip.notes).toHaveLength(1)
    expect(clip.notes[0]).toMatchObject({ pitch: 64, startBeat: 1, durationBeats: 0.5 })

    const loose = takeGroups([
      { trackId: track.id, clipId: null, pitch: 67, startBeat: 2, durationBeats: 1, velocity: 0.5 },
      { trackId: track.id, clipId: null, pitch: 60, startBeat: 4, durationBeats: 0.5, velocity: 0.4 },
    ])
    expect(loose).toHaveLength(1)
    expect(loose[0].startBeat).toBe(2)
    expect(loose[0].notes.map((note) => note.startBeat)).toEqual([0, 2])
    commitKeyboardNotes(store, [
      { trackId: track.id, clipId: null, pitch: 67, startBeat: 8, durationBeats: 1, velocity: 0.6 },
    ])
    expect(track.midiClips.some((item) => item.name === 'Keyboard' && item.notes[0]?.pitch === 67)).toBe(true)
  })

  it('records every pitch a Scaler chord lock sounded, and ends them together', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.setTrackInstrument(track.id, 'scaler')
    store.setScaler(track.id, { keysLock: 'chord', output: 'audio' })
    store.selectTrack(track.id)
    store.preparePianoClip(track.id, 0)
    const clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId)!
    const sounded: number[] = []
    const released: number[] = []
    const live = {
      playThrough(_id: string, pitch: number) { sounded.push(pitch) },
      releaseThrough(_id: string, pitch: number) { released.push(pitch) },
      unlock() {},
      liveNoteOn() {},
      liveNoteOff() {},
    } as unknown as AudioEngine
    const pitches = playKeyboardNote(store, live, 60, 0.8)
    expect(pitches.length).toBeGreaterThan(1)
    expect(sounded).toEqual(pitches)
    const start = clip.startBeat + 1
    let armed = armSounded([], 'ptr:1', pitches, {
      trackId: track.id,
      clipId: clip.id,
      clipStart: clip.startBeat,
      velocity: 0.8,
      startBeat: start,
    })
    const other = armSounded(armed, 'ptr:2', [pitches[0]], {
      trackId: track.id,
      clipId: clip.id,
      clipStart: clip.startBeat,
      velocity: 0.8,
      startBeat: start,
    })
    const chord = releaseGesture(other, 'ptr:1', start + 1.5)
    expect(chord.notes.map((note) => note.pitch).sort((a, b) => a - b)).toEqual([...pitches].sort((a, b) => a - b))
    expect(new Set(chord.notes.map((note) => note.startBeat))).toEqual(new Set([1]))
    expect(new Set(chord.notes.map((note) => note.durationBeats))).toEqual(new Set([1.5]))
    expect(chord.keys.map((key) => key.pitch)).toEqual([pitches[0]])
    commitKeyboardNotes(store, chord.notes)
    expect(clip.notes.map((note) => note.pitch).sort((a, b) => a - b)).toEqual([...pitches].sort((a, b) => a - b))
    for (const pitch of pitches) live.releaseThrough?.(track.id, pitch)
    expect(released.sort((a, b) => a - b)).toEqual([...pitches].sort((a, b) => a - b))
    expect(playKeyboardNote(store, live, 61, 0.8)).toEqual([])
    expect(armSounded([], 'black', [], {
      trackId: track.id,
      clipId: clip.id,
      clipStart: clip.startBeat,
      velocity: 0.8,
      startBeat: start,
    })).toEqual([])
  })
})

describe('piano roll close', () => {
  it('keeps a full-word Close control in the header and returns on back', () => {
    const history = {
      state: null as unknown,
      pushState(data: unknown) { this.state = data },
      back() { this.state = null },
    }
    expect(isPianoHistory(null)).toBe(false)
    expect(markPianoHistory(history)).toBe(true)
    expect(markPianoHistory(history)).toBe(false)
    expect(isPianoHistory(history.state)).toBe(true)

    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.preparePianoClip(track.id, 0)
    let closed = 0
    const html = renderToStaticMarkup(createElement(MidiDock, {
      store,
      engine,
      onClose: () => { closed += 1 },
    }))
    expect(html).toContain('>Close<')
    expect(html).toContain('>Keyboard<')
    expect(html).toContain('class="roll-close"')
    expect(html).not.toContain('fit-item"><button type="button" class="roll-close"')
    expect(closed).toBe(0)
  })

  it('keeps Close at least 40px on a phone and a fold', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.preparePianoClip(track.id, 0)
    const dock = renderToStaticMarkup(createElement(MidiDock, { store, engine, onClose() {} }))
    const browser = await chromium.launch()
    try {
      for (const viewport of [
        { name: 'phone', width: 390, height: 844, shell: 'phone' },
        { name: 'fold', width: 840, height: 900, shell: 'fold' },
      ]) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #101614; }
          ${css}
          .shell { height: ${viewport.height}px; }
        </style></head><body>
          <div class="shell ${viewport.shell}" data-editor="piano">${dock}</div>
        </body></html>`, { waitUntil: 'load' })
        const box = await page.evaluate(() => {
          const button = document.querySelector('.roll-close') as HTMLElement
          const keyboard = document.querySelector('.keyboard-toggle') as HTMLElement
          const closeBox = button.getBoundingClientRect()
          const keyBox = keyboard.getBoundingClientRect()
          return {
            label: button.textContent,
            height: closeBox.height,
            width: closeBox.width,
            keyHeight: keyBox.height,
            keyLabel: keyboard.querySelector('span')?.textContent,
          }
        })
        expect(box.label).toBe('Close')
        expect(box.height).toBeGreaterThanOrEqual(40)
        expect(box.width).toBeGreaterThanOrEqual(40)
        expect(box.keyLabel).toBe('Keyboard')
        expect(box.keyHeight).toBeGreaterThanOrEqual(40)
        await page.screenshot({ path: `/opt/cursor/artifacts/piano-close-${viewport.name}.png` })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })
})

describe('phone keyboard orientation', () => {
  it('locks landscape inside fullscreen and otherwise turns a portrait phone', async () => {
    const locked = host()
    expect(await presentKeyboard(locked)).toBe('locked')
    expect(locked.locked).toEqual(['landscape'])
    expect(locked.entered).toBe(1)
    await dismissKeyboard(locked, 'locked')

    const refused = host({
      async lock() { throw new Error('unsupported') },
    })
    expect(await presentKeyboard(refused)).toBe('turned')
    expect(refused.exited).toBe(1)

    const wide = host({ form: 'fold', portrait: false })
    expect(await presentKeyboard(wide)).toBe('dock')
    const already = host({ portrait: false, fullscreenEnabled: false })
    expect(await presentKeyboard(already)).toBe('dock')
  })

  it('turns the dock along the long side without covering the arrange view', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    store.keyboardMidi = true
    const { KeyboardDock } = await import('../ui/KeyboardDock')
    const markup = renderToStaticMarkup(createElement(KeyboardDock, { store, engine }))
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      await page.setContent(`<!doctype html><html><head><style>
        html, body { margin: 0; height: 100%; background: #0e1512; }
        ${css}
        .shell { height: 844px; width: 390px; }
      </style></head><body>
        <div class="shell phone keys-open keys-turned">
          <header class="topbar"><h1>CueHarbor</h1></header>
          <div class="transport"></div>
          <div class="tool-slot"></div>
          <div class="workspace"><div class="arrange" style="background:#121a16;height:100%"></div></div>
          ${markup}
        </div>
      </body></html>`, { waitUntil: 'load' })
      const box = await page.evaluate(() => {
        const shell = document.querySelector('.shell')!.getBoundingClientRect()
        const dockNode = document.querySelector('.keyboard-dock')!.getBoundingClientRect()
        const work = document.querySelector('.workspace')!.getBoundingClientRect()
        const face = document.querySelector('.keyboard-face') as HTMLElement
        const down = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Octave Down')!
        const close = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Close')!
        const faceBox = face.getBoundingClientRect()
        return {
          dockWidth: dockNode.width,
          dockHeight: dockNode.height,
          dockLeft: dockNode.left,
          workLeft: work.left,
          workRight: work.right,
          shellRight: shell.right,
          faceRight: faceBox.right,
          faceLayoutWidth: face.offsetWidth,
          faceLayoutHeight: face.offsetHeight,
          down: down.getBoundingClientRect().height,
          close: close.getBoundingClientRect().height,
          naturals: document.querySelectorAll('.mini-pad.natural').length,
        }
      })
      expect(box.dockLeft).toBeLessThanOrEqual(1)
      expect(box.dockHeight).toBeGreaterThan(box.dockWidth)
      expect(box.workLeft).toBeGreaterThanOrEqual(box.dockWidth - 1)
      expect(box.workRight).toBeLessThanOrEqual(box.shellRight + 1)
      expect(box.faceRight).toBeLessThanOrEqual(box.workLeft + 2)
      expect(box.faceLayoutWidth).toBeGreaterThan(box.faceLayoutHeight)
      expect(box.down).toBeGreaterThanOrEqual(40)
      expect(box.close).toBeGreaterThanOrEqual(40)
      expect(box.naturals).toBe(7)
      await page.screenshot({ path: '/opt/cursor/artifacts/keyboard-phone-turned.png' })
      await page.close()
    } finally {
      await browser.close()
    }
  })
})
