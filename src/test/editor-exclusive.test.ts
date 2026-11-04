import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { editorForGesture, noteEditorsAfterOpen, releaseKeyboardForPiano } from '../model/editorOpen'
import { midiLit, pruneMidiMarks } from '../model/midiActivity'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { holdMeter, meterFill } from '../ui/levels'
import { editorHistoryStep, isPadsHistory, isPianoHistory } from '../ui/keyboardStage'
import { ArrangeView } from '../ui/ArrangeView'
import { PadsPanel } from '../ui/PadsPanel'

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  unlock() {},
  playThrough() {},
  releaseThrough() {},
  liveNoteOn() {},
  liveNoteOff() {},
  currentTimelineSample: () => 0,
  stopPreview() {},
  previewPcm() {},
  levels: () => ({ tracks: {}, master: 0, input: 0, talk: 0 }),
  midiActivity: () => ({}),
} as unknown as AudioEngine

describe('keyboard and piano roll stay exclusive', () => {
  it('closes the other editor in both directions', () => {
    expect(noteEditorsAfterOpen('keyboard')).toEqual({ keyboard: true, piano: false })
    expect(noteEditorsAfterOpen('piano')).toEqual({ keyboard: false, piano: true })
    expect(editorForGesture('select-track', 'midi')).toBe('keyboard')
    expect(editorForGesture('select-track', 'midi', { instrument: 'pads' })).toBe('pads')
    expect(editorForGesture('tap-clip', 'midi')).toBe('piano')
    expect(editorForGesture('tap-clip', 'midi', { instrument: 'pads' })).toBe('piano')
    expect(editorForGesture('edit-notes', 'midi')).toBe('piano')
    expect(editorForGesture('tap-clip', 'audio')).toBe('none')
  })

  it('closes the keyboard for the piano roll without restoring Beat Machine', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.openKeyboardForPads(id)
    expect(store.keyboardMidi).toBe(true)
    expect(store.padsTrackId).toBeNull()
    expect(releaseKeyboardForPiano(store)).toBe(true)
    expect(store.keyboardMidi).toBe(false)
    expect(store.padsTrackId).toBeNull()
    expect(releaseKeyboardForPiano(store)).toBe(false)
  })

  it('replaces one editor history entry instead of stacking them', () => {
    expect(editorHistoryStep(null, null)).toBe('keep')
    expect(editorHistoryStep(null, 'piano')).toBe('push')
    expect(editorHistoryStep('piano', 'pads')).toBe('replace')
    expect(editorHistoryStep('pads', 'piano')).toBe('replace')
    expect(editorHistoryStep('piano', null)).toBe('back')
    expect(isPianoHistory({ cueharbor: 'piano' })).toBe(true)
    expect(isPadsHistory({ cueharbor: 'pads' })).toBe(true)
    expect(isPianoHistory({ cueharbor: 'pads' })).toBe(false)
  })

  it('draws a clip editor target and an idle header meter on every track', () => {
    const store = new ProjectStore(createEmptyProject())
    const html = renderToStaticMarkup(createElement(ArrangeView, {
      store,
      engine,
      session: { state: { participants: [], selfId: 'me' } },
      onSeek() {},
      onOpenPiano() {},
      onOpenKeyboard() {},
      onPerform() {},
      onQuickPunch() {},
      onAnalyze() {},
    } as never))
    const tracks = store.project.tracks
    expect(tracks.length).toBeGreaterThanOrEqual(3)
    for (const track of tracks) {
      expect(html).toContain(`data-arrange-meter="${track.id}"`)
      expect(html).toContain(`data-midi-activity="${track.id}"`)
      expect(html).toContain('data-lit="0"')
    }
    expect(html).toContain('class="mini-meter"')
    expect(html).toContain('MIDI activity. Idle.')
  })
})

describe('beat machine close and live meters', () => {
  it('gives Beat Machine a full Close word and shares the mixer meter scale', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    expect(html).toContain('class="mpc-close"')
    expect(html).toContain('>Close<')
    expect(html).not.toContain('class="hw-key ch-tab mpc-close"')
    const css = readFileSync(new URL('../ui/pads.css', import.meta.url), 'utf8')
    const rule = css.slice(css.indexOf('.mpc-keyboard,'), css.indexOf('.mpc-pad-tools'))
    expect(rule).toContain('.mpc-close')
    expect(rule).toContain('min-height: 44px')
    expect(rule).toContain('min-width: 40px')
    expect(rule).toContain('background-color: var(--accent)')
    expect(rule).toContain('color: var(--accent-ink)')
    expect(rule).toContain('text-transform: none')
    expect(meterFill(0)).toBe(0)
    expect(meterFill(0.25)).toBeCloseTo(0.8)
    expect(meterFill(2)).toBe(1)
    expect(meterFill(Number.NaN)).toBe(0)
    const hold = { value: 0, at: 0 }
    expect(holdMeter(hold, 0.05, 1000)).toBeCloseTo(meterFill(0.05))
    expect(holdMeter(hold, 0, 1100)).toBeCloseTo(meterFill(0.05))
    expect(holdMeter(hold, 0, 1000 + 220 + 280)).toBe(0)
    const rising = { value: 0.1, at: 0 }
    expect(holdMeter(rising, 0.5, 50)).toBeCloseTo(meterFill(0.5))
  })

  it('lights only the tracks that have a note in the window', () => {
    const marks = [
      { id: 'keys', from: 1, until: 1.4 },
      { id: 'drums', from: 2, until: 2.2 },
    ]
    expect(midiLit(marks, new Set(), 1.2)).toEqual({ keys: true })
    expect(midiLit(marks, new Set(['vocal']), 0.2)).toEqual({ vocal: true })
    expect(midiLit(marks, new Set(), 3)).toEqual({})
    expect(pruneMidiMarks(marks, 2.3).map((mark) => mark.id)).toEqual([])
    expect(pruneMidiMarks(marks, 1.3).map((mark) => mark.id)).toEqual(['keys', 'drums'])
  })
})

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function readLives(page: Page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>('.head')].map((head) => {
      const name = (head.querySelector('input.name') as HTMLInputElement | null)?.value || ''
      const meter = head.querySelector('.mini-meter') as HTMLElement | null
      const bar = head.querySelector('.mini-meter i') as HTMLElement | null
      const midi = head.querySelector('.midi-activity') as HTMLElement | null
      const box = meter?.getBoundingClientRect()
      const match = /scaleX\(([^)]+)\)/.exec(bar?.style.transform || '')
      const mute = head.querySelector('button[aria-label="Mute track"], button[aria-label="Unmute track"]') as HTMLElement | null
      const muteBox = mute?.getBoundingClientRect()
      return {
        name,
        scale: match ? Number(match[1]) : 0,
        meterW: box?.width ?? 0,
        meterH: box?.height ?? 0,
        shown: !!meter && getComputedStyle(meter).display !== 'none' && (box?.width ?? 0) >= 20 && (box?.height ?? 0) >= 6,
        lit: midi?.getAttribute('data-lit') === '1',
        muteH: muteBox?.height ?? 0,
      }
    })
  })
}

async function peaksWhile(page: Page, during: () => Promise<void>) {
  await page.evaluate(() => {
    const host = window as unknown as { __lives?: Record<string, { scale: number; lit: boolean; engine: number }>; __liveTimer?: number }
    host.__lives = {}
    host.__liveTimer = window.setInterval(() => {
      const hook = (window as unknown as { __cueharbor?: { engine: { levels: () => { tracks: Record<string, number> } } } }).__cueharbor
      const lives = host.__lives ?? {}
      for (const head of document.querySelectorAll<HTMLElement>('.head')) {
        const id = head.getAttribute('data-track') || ''
        const name = (head.querySelector('input.name') as HTMLInputElement | null)?.value || ''
        const bar = head.querySelector('.mini-meter i') as HTMLElement | null
        const match = /scaleX\(([^)]+)\)/.exec(bar?.style.transform || '')
        const scale = match ? Number(match[1]) : 0
        const lit = head.querySelector('.midi-activity')?.getAttribute('data-lit') === '1'
        const engine = id ? (hook?.engine.levels().tracks[id] ?? 0) : 0
        const prev = lives[name] ?? { scale: 0, lit: false, engine: 0 }
        lives[name] = { scale: Math.max(prev.scale, scale), lit: prev.lit || lit, engine: Math.max(prev.engine, engine) }
      }
      host.__lives = lives
    }, 20)
  })
  await during()
  await page.waitForTimeout(700)
  const lives = await page.evaluate(() => (window as unknown as { __lives: Record<string, { scale: number; lit: boolean; engine: number }> }).__lives)
  await page.evaluate(() => window.clearInterval((window as unknown as { __liveTimer?: number }).__liveTimer))
  return lives
}

describe('editors, close, and header meters in the app', () => {
  it('keeps the keyboard and piano roll apart, closes Beat Machine, and meters the played track', async () => {
    const port = 4227
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, child)
      for (const viewport of [
        { width: 390, height: 844, phone: true },
        { width: 1280, height: 800, phone: false },
      ]) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
        const page = await context.newPage()
        const label = `${viewport.width}x${viewport.height}`
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('textbox', { name: 'Keys name' }).waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count(), label).toBe(0)
        expect(await page.locator('[data-editor="piano"]').count(), label).toBe(0)

        const resting = await readLives(page)
        expect(resting.map((row) => row.name), label).toEqual(expect.arrayContaining(['Vocal', 'Music', 'Keys']))
        for (const row of resting) {
          expect(row.shown, `${label} ${row.name} meter`).toBe(true)
          expect(row.lit, `${label} ${row.name} idle`).toBe(false)
          expect(row.muteH, `${label} ${row.name} mute`).toBeGreaterThanOrEqual(viewport.phone ? 40 : 22)
        }

        await page.getByRole('textbox', { name: 'Keys name' }).click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        expect(await page.locator('[data-editor="piano"]').count(), label).toBe(0)
        if (viewport.phone) {
          await page.waitForFunction(() => {
            const shell = document.querySelector('.shell')
            return shell?.classList.contains('keys-landscape') || document.fullscreenElement != null
          })
        }

        const clipId = await page.evaluate(() => {
          const hook = (window as unknown as {
            __cueharbor?: { store: { project: { tracks: { id: string; name: string }[] }; addMidiClip: (id: string, beat: number) => void; selectedMidiClipId: string | null } }
          }).__cueharbor
          const keys = hook!.store.project.tracks.find((track) => track.name === 'Keys')!
          hook!.store.addMidiClip(keys.id, 0)
          return hook!.store.selectedMidiClipId
        })
        await page.locator(`[data-clip="${clipId}"]`).click()
        await page.locator('[data-editor="piano"]').waitFor()
        await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })
        if (viewport.phone) {
          await page.waitForFunction(() => !document.querySelector('.shell')?.classList.contains('keys-landscape'))
        }

        await page.locator('.roll-pinned .keyboard-toggle').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        await page.locator('[data-editor="piano"]').waitFor({ state: 'detached' })
        if (viewport.phone) {
          await page.waitForFunction(() => {
            const shell = document.querySelector('.shell')
            return shell?.classList.contains('keys-landscape') || document.fullscreenElement != null
          })
        }

        await page.locator('.keyboard-edit').click()
        await page.locator('[data-editor="piano"]').waitFor()
        await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })
        await page.locator('.roll-close').click()
        await page.locator('[data-editor="piano"]').waitFor({ state: 'detached' })

        await page.getByRole('textbox', { name: 'Keys name' }).click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        expect(await page.locator('[data-editor="piano"]').count(), label).toBe(0)
        const played = await peaksWhile(page, async () => {
          await page.locator('.keyboard-dock .mini-pad.natural').first().click({ delay: 280 })
        })
        expect(played.Keys.engine, label).toBeGreaterThan(0.01)
        expect(played.Keys.scale, label).toBeGreaterThan(0.02)
        expect(played.Keys.lit, label).toBe(true)
        expect(played.Vocal.engine, label).toBeLessThan(0.005)
        expect(played.Vocal.scale, label).toBeLessThan(0.02)
        expect(played.Vocal.lit, label).toBe(false)
        expect(played.Music.engine, label).toBeLessThan(0.005)
        expect(played.Music.scale, label).toBeLessThan(0.02)
        expect(played.Music.lit, label).toBe(false)

        await page.locator('.keyboard-close').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })
        await page.waitForTimeout(350)
        const keysHead = page.locator('.head', { has: page.getByRole('textbox', { name: 'Keys name' }) })
        await keysHead.getByRole('button', { name: 'Mute track' }).click()
        const muted = await peaksWhile(page, async () => {
          await page.evaluate(() => {
            const hook = (window as unknown as {
              __cueharbor?: { engine: { playThrough: (id: string, pitch: number, velocity: number) => void; releaseThrough: (id: string, pitch: number) => void }; store: { project: { tracks: { id: string; name: string }[] } } }
            }).__cueharbor!
            const keys = hook.store.project.tracks.find((track) => track.name === 'Keys')!
            hook.engine.playThrough(keys.id, 64, 0.9)
            window.setTimeout(() => hook.engine.releaseThrough(keys.id, 64), 280)
          })
        })
        expect(muted.Keys.engine, `${label} muted`).toBeLessThan(0.005)
        expect(muted.Keys.scale, `${label} muted`).toBeLessThan(0.02)
        expect(muted.Keys.lit, `${label} muted midi`).toBe(true)
        await keysHead.getByRole('button', { name: 'Unmute track' }).click()

        await page.getByRole('button', { name: 'Add Track' }).click()
        await page.getByRole('button', { name: /Beat Machine\. Pads/ }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count(), label).toBe(0)
        expect(await page.locator('[data-editor="piano"]').count(), label).toBe(0)
        const close = page.getByRole('button', { name: 'Close Beat Machine. The track keeps the instrument.' })
        await close.scrollIntoViewIfNeeded()
        const closeBox = await close.boundingBox()
        const closePaint = await close.evaluate((node) => {
          const style = getComputedStyle(node)
          return { text: node.textContent, background: style.backgroundColor, color: style.color }
        })
        expect(closeBox!.width, label).toBeGreaterThanOrEqual(40)
        expect(closeBox!.height, label).toBeGreaterThanOrEqual(40)
        expect(closePaint.text, label).toBe('Close')
        expect(closePaint.background, label).toBe('rgb(115, 196, 143)')
        expect(closePaint.color, label).toBe('rgb(16, 33, 23)')
        await close.click()
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

        await page.getByRole('textbox', { name: 'Beat Machine 1 name' }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count(), label).toBe(0)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.keyboard.press('Escape')
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

        await page.getByRole('textbox', { name: 'Beat Machine 1 name' }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        await page.goBack()
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

        const beatClip = await page.evaluate(() => {
          const hook = (window as unknown as {
            __cueharbor?: { store: { project: { tracks: { id: string; name: string }[] }; addMidiClip: (id: string, beat: number) => void; selectedMidiClipId: string | null } }
          }).__cueharbor!
          const beat = hook.store.project.tracks.find((track) => track.name === 'Beat Machine 1')!
          hook.store.addMidiClip(beat.id, 0)
          return hook.store.selectedMidiClipId
        })
        await page.locator(`[data-clip="${beatClip}"]`).click()
        await page.locator('[data-editor="piano"]').waitFor()
        expect(await page.locator('[data-pads="plugin"]').count(), label).toBe(0)
        expect(await page.locator('[data-keyboard-dock="open"]').count(), label).toBe(0)
        await page.locator('.roll-close').click()
        await page.locator('[data-editor="piano"]').waitFor({ state: 'detached' })

        await page.getByRole('textbox', { name: 'Beat Machine 1 name' }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        await page.locator('[data-beat-keyboard]').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })
        const drums = await peaksWhile(page, async () => {
          await page.locator('.keyboard-dock [data-pitch="36"]').click({ delay: 280 })
          await page.evaluate(() => {
            const hook = (window as unknown as {
              __cueharbor?: { engine: { playThrough: (id: string, pitch: number, velocity: number) => void; releaseThrough: (id: string, pitch: number) => void }; store: { project: { tracks: { id: string; name: string }[] } } }
            }).__cueharbor!
            const beat = hook.store.project.tracks.find((track) => track.name === 'Beat Machine 1')!
            hook.engine.playThrough(beat.id, 36, 0.95)
            window.setTimeout(() => hook.engine.releaseThrough(beat.id, 36), 400)
          })
        })
        expect(drums['Beat Machine 1'].engine, label).toBeGreaterThan(0.005)
        expect(drums['Beat Machine 1'].scale, label).toBeGreaterThan(0.01)
        expect(drums['Beat Machine 1'].lit, label).toBe(true)
        expect(drums.Keys.lit, label).toBe(false)
        expect(drums.Keys.scale, label).toBeLessThan(0.02)
        expect(drums.Vocal.lit, label).toBe(false)

        await page.locator('.keyboard-close').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })
        await page.locator('[data-pads="plugin"]').waitFor()
        const vocal = await peaksWhile(page, async () => {
          await page.evaluate(() => {
            const hook = (window as unknown as {
              __cueharbor?: { engine: { playThrough: (id: string, pitch: number, velocity: number) => void; releaseThrough: (id: string, pitch: number) => void }; store: { project: { tracks: { id: string; name: string }[] } } }
            }).__cueharbor!
            const track = hook.store.project.tracks.find((item) => item.name === 'Vocal')!
            hook.engine.playThrough(track.id, 67, 0.9)
            window.setTimeout(() => hook.engine.releaseThrough(track.id, 67), 250)
          })
        })
        expect(vocal.Vocal.engine, label).toBeGreaterThan(0.01)
        expect(vocal.Vocal.scale, label).toBeGreaterThan(0.02)
        expect(vocal.Vocal.lit, label).toBe(true)
        expect(vocal.Keys.scale, label).toBeLessThan(0.02)
        expect(vocal.Keys.lit, label).toBe(false)
        expect(vocal.Music.lit, label).toBe(false)
        await context.close()
      }
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
