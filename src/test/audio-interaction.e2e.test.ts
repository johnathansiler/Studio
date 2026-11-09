import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

function press(page: Page, selector: string, pointerId: number, pointerType: 'touch' | 'mouse', holdMs: number) {
  return page.evaluate(async ({ selector, pointerId, pointerType, holdMs }) => {
    const node = document.querySelector(selector) as HTMLElement | null
    if (!node) return { missing: true }
    const box = node.getBoundingClientRect()
    const point = { x: box.left + box.width / 2, y: box.top + Math.min(box.height - 4, 10) }
    const fire = (type: string, buttons: number) => {
      node.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType,
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        pressure: pointerType === 'touch' ? 0.7 : 0.5,
        width: pointerType === 'touch' ? 14 : 1,
        height: pointerType === 'touch' ? 14 : 1,
      }))
    }
    fire('pointerdown', 1)
    await new Promise((resolve) => setTimeout(resolve, holdMs))
    fire('pointerup', 0)
    return { missing: false }
  }, { selector, pointerId, pointerType, holdMs })
}

describe('loop load and beat machine pads', () => {
  it('loads a live loop onto Arrange and plays pads with Note Repeat off and on', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4500 + Math.floor(Math.random() * 200)
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    try {
      await waitForServer(url, web)
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.waitForFunction(() => {
        const hook = (window as unknown as {
          __cueharbor: { engine: { seek: (sample: number) => void; currentTimelineSample: () => number }; store: { project: { sampleRate: number } } }
          __playheadHold?: { sample: number; at: number }
        })
        const sample = hook.__cueharbor.store.project.sampleRate * 2
        const now = performance.now()
        if (hook.__cueharbor.engine.currentTimelineSample() !== sample) {
          hook.__cueharbor.engine.seek(sample)
          hook.__playheadHold = { sample, at: now }
          return false
        }
        if (!hook.__playheadHold || hook.__playheadHold.sample !== sample) hook.__playheadHold = { sample, at: now }
        return now - hook.__playheadHold.at > 400
      })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { id: string; type: string }[] }; selectTrack: (id: string) => void } }
        }).__cueharbor.store
        const midi = store.project.tracks.find((track) => track.type === 'midi')
        if (!midi) throw new Error('missing midi track')
        store.selectTrack(midi.id)
      })
      await page.getByRole('button', { name: 'Browser', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor()
      await page.locator('.browser-tabs').getByRole('button', { name: 'Sounds', exact: true }).click()
      await page.getByLabel('Search sounds').fill('2-AND-4 (120)')
      const row = page.locator('.sound-row', { hasText: '2-AND-4 (120)' }).first()
      await row.waitFor({ timeout: 20000 })
      const loopName = (await row.locator('strong').innerText()).trim()
      await row.locator('.sound-copy').tap()
      await page.locator('.sound-row.is-playing').waitFor({ timeout: 15000 })
      await row.getByRole('button', { name: /^Load/ }).tap()
      await page.locator('[data-clip]').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(150)
      const loaded = await page.evaluate((name) => {
        const store = (window as unknown as {
          __cueharbor: {
            store: {
              selectedTrackId: string | null
              project: { tracks: { id: string; name: string; type: string; clips: { id: string; name: string; startSample: number; durationSamples: number; bufferId: string; notes?: unknown }[] }[] }
              buffers: Map<string, { channels: Float32Array[] }>
            }
          }
        }).__cueharbor.store
        const host = store.project.tracks.find((track) => track.clips.some((clip) => clip.name === name))
        const clip = host?.clips.find((item) => item.name === name)
        const channel = clip ? store.buffers.get(clip.bufferId)?.channels[0] : undefined
        let peak = 0
        if (channel) for (let i = 0; i < channel.length; i += 32) peak = Math.max(peak, Math.abs(channel[i] || 0))
        const node = clip ? document.querySelector(`[data-clip="${clip.id}"]`) as HTMLElement | null : null
        const canvas = node?.querySelector('canvas') as HTMLCanvasElement | null
        const view = canvas?.getContext('2d', { willReadFrequently: true })
        let ink = 0
        if (view && canvas && canvas.width > 0 && canvas.height > 0) {
          const pixels = view.getImageData(0, 0, canvas.width, canvas.height).data
          for (let i = 3; i < pixels.length; i += 16) if (pixels[i] > 16) ink += 1
        }
        const box = node?.getBoundingClientRect()
        const timeline = document.querySelector('.timeline-scroll')?.getBoundingClientRect()
        const alert = document.querySelector('.sound-panel [role="alert"]')?.textContent ?? ''
        return {
          name: host?.name ?? '',
          type: host?.type ?? '',
          selected: host?.id === store.selectedTrackId,
          start: clip?.startSample ?? -1,
          dur: clip?.durationSamples ?? 0,
          peak,
          notes: clip && 'notes' in clip ? 1 : 0,
          ink,
          seen: !!box && !!timeline && box.bottom > timeline.top + 4 && box.top < timeline.bottom - 4 && box.right > timeline.left + 4,
          alert,
        }
      }, loopName)
      expect(loaded.alert, loopName).toBe('')
      expect(loaded.type).toBe('audio')
      expect(loaded.selected).toBe(true)
      expect(loaded.name).not.toMatch(/Keys|Beat/)
      expect(loaded.start).toBeGreaterThan(40000)
      expect(loaded.dur).toBeGreaterThan(1000)
      expect(loaded.peak).toBeGreaterThan(0.05)
      expect(loaded.notes).toBe(0)
      expect(loaded.ink).toBeGreaterThan(8)
      expect(loaded.seen).toBe(true)
      expect(await page.locator('.clip-wave .wave-zoom').count()).toBe(0)
      expect(await page.locator('.sound-row.is-playing').count()).toBe(0)
      await page.screenshot({ path: '/opt/cursor/artifacts/loop-load-playhead-390.png' })

      await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor: { engine: { resume: () => Promise<void>; seek: (sample: number) => void; playAtPerf?: (sample: number, perf: number, mode: string) => Promise<void>; levels: () => { master: number } } }
        }).__cueharbor
        await hook.engine.resume()
        const start = (window as unknown as { __cueharbor: { store: { project: { tracks: { type: string; clips: { startSample: number }[] }[] } } } }).__cueharbor.store.project.tracks.flatMap((track) => track.clips)[0]?.startSample ?? 0
        hook.engine.seek(start)
        await hook.engine.playAtPerf?.(start, performance.now(), 'arrangement')
      })
      let heard = 0
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(80)
        heard = Math.max(heard, await page.evaluate(() => (window as unknown as { __cueharbor: { engine: { levels: () => { master: number } } } }).__cueharbor.engine.levels().master || 0))
      }
      expect(heard).toBeGreaterThan(0.02)
      await page.evaluate(() => (window as unknown as { __cueharbor: { engine: { stop?: () => void } } }).__cueharbor.engine.stop?.())

      const beforeSave = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: {
            store: {
              hasUnsavedEdits: () => boolean
              project: { tracks: { id: string; type: string; clips: { id: string; name: string; startSample: number; durationSamples: number; bufferId: string }[] }[] }
              buffers: Map<string, { sampleRate: number; channels: Float32Array[] }>
            }
          }
        }).__cueharbor.store
        const host = store.project.tracks.find((track) => track.clips.some((clip) => clip.durationSamples > 1000))
        const clip = host?.clips.find((item) => item.durationSamples > 1000)
        const channel = clip ? store.buffers.get(clip.bufferId)?.channels[0] : undefined
        let peak = 0
        let sum = 0
        if (channel) {
          const step = Math.max(1, Math.floor(channel.length / 4000))
          for (let i = 0; i < channel.length; i += step) {
            const value = Math.abs(channel[i] || 0)
            peak = Math.max(peak, value)
            sum += value
          }
        }
        return {
          name: clip?.name ?? '',
          track: host?.id ?? '',
          type: host?.type ?? '',
          start: clip?.startSample ?? -1,
          dur: clip?.durationSamples ?? 0,
          bufferId: clip?.bufferId ?? '',
          rate: clip ? store.buffers.get(clip.bufferId)?.sampleRate ?? 0 : 0,
          length: channel?.length ?? 0,
          peak,
          sum,
        }
      })
      expect(beforeSave.length).toBeGreaterThan(1000)
      expect(beforeSave.peak).toBeGreaterThan(0.05)
      const saved = await page.evaluate(async () => {
        window.dispatchEvent(new Event('pagehide'))
        const store = (window as unknown as { __cueharbor: { store: { hasUnsavedEdits: () => boolean } } }).__cueharbor.store
        const started = performance.now()
        while (store.hasUnsavedEdits() && performance.now() - started < 8000) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return !store.hasUnsavedEdits()
      })
      expect(saved).toBe(true)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.waitForFunction((name) => {
        const store = (window as unknown as {
          __cueharbor?: { store: { project: { tracks: { clips: { name: string }[] }[] }; buffers: Map<string, { channels: Float32Array[] }> } }
        }).__cueharbor?.store
        if (!store) return false
        const clip = store.project.tracks.flatMap((track) => track.clips).find((item) => item.name === name)
        return !!clip
      }, beforeSave.name)
      const reopened = await page.evaluate(async (before) => {
        const hook = (window as unknown as {
          __cueharbor: {
            engine: { resume: () => Promise<void>; seek: (sample: number) => void; playAtPerf?: (sample: number, perf: number, mode: string) => Promise<void>; stop?: () => void; levels: () => { master: number } }
            store: {
              project: { tracks: { id: string; type: string; clips: { id: string; name: string; startSample: number; durationSamples: number; bufferId: string }[] }[] }
              buffers: Map<string, { sampleRate: number; channels: Float32Array[] }>
            }
          }
        }).__cueharbor
        const host = hook.store.project.tracks.find((track) => track.id === before.track) ?? hook.store.project.tracks.find((track) => track.clips.some((clip) => clip.name === before.name))
        const clip = host?.clips.find((item) => item.name === before.name)
        const channel = clip ? hook.store.buffers.get(clip.bufferId)?.channels[0] : undefined
        let peak = 0
        let sum = 0
        if (channel) {
          const step = Math.max(1, Math.floor(channel.length / 4000))
          for (let i = 0; i < channel.length; i += step) {
            const value = Math.abs(channel[i] || 0)
            peak = Math.max(peak, value)
            sum += value
          }
        }
        const node = clip ? document.querySelector(`[data-clip="${clip.id}"]`) as HTMLElement | null : null
        node?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        let ink = 0
        for (let attempt = 0; attempt < 20 && ink < 8; attempt += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const canvas = node?.querySelector('canvas') as HTMLCanvasElement | null
          const view = canvas?.getContext('2d', { willReadFrequently: true })
          ink = 0
          if (!view || !canvas || canvas.width < 1 || canvas.height < 1) continue
          const pixels = view.getImageData(0, 0, canvas.width, canvas.height).data
          for (let i = 3; i < pixels.length; i += 16) if (pixels[i] > 16) ink += 1
        }
        const box = node?.getBoundingClientRect()
        const timeline = document.querySelector('.timeline-scroll')?.getBoundingClientRect()
        await hook.engine.resume()
        hook.engine.seek(clip?.startSample ?? 0)
        await hook.engine.playAtPerf?.(clip?.startSample ?? 0, performance.now(), 'arrangement')
        let master = 0
        const started = performance.now()
        while (performance.now() - started < 900) {
          master = Math.max(master, hook.engine.levels().master || 0)
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        hook.engine.stop?.()
        return {
          type: host?.type ?? '',
          start: clip?.startSample ?? -1,
          dur: clip?.durationSamples ?? 0,
          bufferId: clip?.bufferId ?? '',
          rate: clip ? hook.store.buffers.get(clip.bufferId)?.sampleRate ?? 0 : 0,
          length: channel?.length ?? 0,
          peak,
          sum,
          ink,
          seen: !!box && !!timeline && box.bottom > timeline.top + 4 && box.top < timeline.bottom - 4 && box.right > timeline.left + 4,
          master,
        }
      }, beforeSave)
      expect(reopened.type).toBe('audio')
      expect(reopened.start).toBe(beforeSave.start)
      expect(reopened.dur).toBe(beforeSave.dur)
      expect(reopened.bufferId).toBe(beforeSave.bufferId)
      expect(reopened.rate).toBe(beforeSave.rate)
      expect(reopened.length).toBe(beforeSave.length)
      expect(reopened.peak).toBeGreaterThan(0.05)
      expect(reopened.sum).toBeGreaterThan(beforeSave.sum * 0.98)
      expect(reopened.ink).toBeGreaterThan(8)
      expect(reopened.seen).toBe(true)
      expect(reopened.master).toBeGreaterThan(0.02)
      await page.screenshot({ path: '/opt/cursor/artifacts/loop-reload-390.png' })

      const closer = page.locator('.browser-close')
      if (await closer.isVisible().catch(() => false)) await closer.click()
      await page.getByRole('button', { name: 'Add Track' }).click()
      await page.getByRole('button', { name: /Beat Machine\. Pads/ }).click()
      await page.locator('[data-pads="plugin"]').waitFor()
      await page.locator('.mpc-pad').first().waitFor()

      const fresh = await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor: { engine: { resume: () => Promise<void>; heardPads: unknown[]; levels: () => { master: number } } }
        }).__cueharbor
        await hook.engine.resume()
        hook.engine.heardPads.length = 0
        return hook.engine.heardPads.length
      })
      expect(fresh).toBe(0)
      await press(page, '.mpc-pad', 11, 'touch', 90)
      let offLevel = 0
      let offHeard = 0
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(40)
        const sample = await page.evaluate(() => {
          const engine = (window as unknown as { __cueharbor: { engine: { heardPads: unknown[]; levels: () => { master: number } } } }).__cueharbor.engine
          return { heard: engine.heardPads.length, master: engine.levels().master || 0 }
        })
        offHeard = Math.max(offHeard, sample.heard)
        offLevel = Math.max(offLevel, sample.master)
      }
      expect(offHeard).toBeGreaterThan(0)
      expect(offLevel).toBeGreaterThan(0.02)

      const repeat = page.locator('.note-repeat-hold')
      const before = await repeat.evaluate((node) => getComputedStyle(node).backgroundColor)
      await repeat.dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 })
      await expect.poll(async () => repeat.getAttribute('data-down')).toBe('1')
      const pressed = await repeat.evaluate((node) => ({
        down: node.classList.contains('down'),
        on: node.classList.contains('on'),
        radius: getComputedStyle(node).borderRadius,
        bg: getComputedStyle(node).backgroundColor,
      }))
      expect(pressed.down).toBe(true)
      expect(pressed.on).toBe(false)
      expect(parseFloat(pressed.radius)).toBe(12)
      expect(pressed.bg).not.toBe(before)
      await page.screenshot({ path: '/opt/cursor/artifacts/note-repeat-pressed-390.png' })
      await repeat.dispatchEvent('pointerup', { pointerId: 21, pointerType: 'touch', button: 0, buttons: 0 })
      await repeat.dispatchEvent('pointerleave', { pointerId: 21, pointerType: 'touch' })
      await repeat.click()
      await expect.poll(async () => repeat.getAttribute('aria-pressed')).toBe('true')
      const latched = await repeat.evaluate((node) => ({
        down: node.getAttribute('data-down'),
        on: node.classList.contains('on'),
        bg: getComputedStyle(node).backgroundColor,
      }))
      expect(latched.down).toBe('0')
      expect(latched.on).toBe(true)
      expect(latched.bg).not.toBe(before)
      expect(latched.bg).not.toBe(pressed.bg)
      await page.screenshot({ path: '/opt/cursor/artifacts/note-repeat-on-390.png' })

      const pad = page.locator('.mpc-pad').first()
      await pad.dispatchEvent('pointerdown', { pointerId: 31, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, pressure: 0.6 })
      await expect.poll(async () => pad.getAttribute('aria-pressed')).toBe('true')
      await page.screenshot({ path: '/opt/cursor/artifacts/pad-pressed-repeat-on-390.png' })
      await page.waitForTimeout(280)
      await pad.dispatchEvent('pointercancel', { pointerId: 31, pointerType: 'mouse', button: 0, buttons: 0 })
      await expect.poll(async () => pad.getAttribute('aria-pressed')).toBe('false')
      await repeat.click()
      await expect.poll(async () => repeat.getAttribute('aria-pressed')).toBe('false')

      await press(page, '.mpc-pad', 41, 'mouse', 70)
      let afterCancel = 0
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(40)
        afterCancel = Math.max(afterCancel, await page.evaluate(() => (window as unknown as { __cueharbor: { engine: { levels: () => { master: number } } } }).__cueharbor.engine.levels().master || 0))
      }
      expect(afterCancel).toBeGreaterThan(0.02)
      await page.screenshot({ path: '/opt/cursor/artifacts/note-repeat-off-390.png' })

      await page.locator('[data-plugin-transport="open"] [aria-label="Record"]').click()
      await page.waitForFunction(() => {
        const status = (window as unknown as { __cueharbor?: { engine: { status: string } } }).__cueharbor?.engine.status
        return status === 'recording' || status === 'counting-in'
      })
      await page.waitForFunction(() => (window as unknown as { __cueharbor?: { engine: { status: string } } }).__cueharbor?.engine.status === 'recording')
      await press(page, '.mpc-pad', 51, 'touch', 80)
      await press(page, '.mpc-pad:nth-child(2)', 52, 'touch', 80)
      await page.locator('[data-plugin-transport="open"] [aria-label="Stop"]').click()
      await page.waitForFunction(() => {
        const hook = (window as unknown as { __cueharbor?: { engine: { status: string }; store: { padRecord: unknown } } }).__cueharbor
        return hook?.engine.status === 'stopped' && !hook.store.padRecord
      })
      const take = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { instrument?: string; midiClips: { name: string; notes: { pitch: number; startBeat: number }[] }[] }[] } } }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.instrument === 'pads')
        const clip = track?.midiClips.find((item) => item.notes.length)
        const notes = clip?.notes ?? []
        const starts = notes.map((note) => note.startBeat).sort((a, b) => a - b)
        let close = 0
        for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] < 0.03) close += 1
        return { pitches: notes.map((note) => note.pitch), close, count: notes.length }
      })
      expect(take.count).toBe(2)
      expect(take.close).toBe(0)
      expect(new Set(take.pitches).size).toBe(2)

      const beforeRepeat = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { instrument?: string; midiClips: { notes: { pitch: number; startBeat: number }[] }[] }[] } } }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.instrument === 'pads')
        return track?.midiClips.flatMap((clip) => clip.notes).map((note) => `${note.pitch}:${note.startBeat.toFixed(3)}`) ?? []
      })
      await page.locator('[data-plugin-transport="open"] [aria-label="Record"]').click()
      await page.waitForFunction(() => (window as unknown as { __cueharbor?: { engine: { status: string } } }).__cueharbor?.engine.status === 'recording')
      await repeat.click()
      await expect.poll(async () => repeat.getAttribute('aria-pressed')).toBe('true')
      await press(page, '.mpc-pad', 61, 'touch', 360)
      await repeat.dispatchEvent('pointerup', { pointerId: 70, pointerType: 'touch' })
      await page.locator('[data-plugin-transport="open"] [aria-label="Stop"]').click()
      await page.waitForFunction(() => !(window as unknown as { __cueharbor?: { store: { padRecord: unknown } } }).__cueharbor?.store.padRecord)
      const repeated = await page.evaluate((before) => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { instrument?: string; midiClips: { notes: { pitch: number; startBeat: number }[] }[] }[] } } }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.instrument === 'pads')
        const notes = track?.midiClips.flatMap((clip) => clip.notes) ?? []
        const seen = new Map<string, number>()
        for (const key of before) seen.set(key, (seen.get(key) ?? 0) + 1)
        const added: { pitch: number; startBeat: number }[] = []
        for (const note of notes) {
          const key = `${note.pitch}:${note.startBeat.toFixed(3)}`
          const left = seen.get(key) ?? 0
          if (left > 0) seen.set(key, left - 1)
          else added.push(note)
        }
        const pitch = added[0]?.pitch
        const kicks = added.filter((note) => note.pitch === pitch)
        const starts = kicks.map((note) => note.startBeat).sort((a, b) => a - b)
        let close = 0
        for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] < 0.03) close += 1
        return { count: added.length, close, kicks: kicks.length }
      }, beforeRepeat)
      expect(repeated.kicks).toBeGreaterThanOrEqual(3)
      expect(repeated.close).toBe(0)
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-repeat-record-390.png' })

      await page.getByRole('button', { name: /Close Beat Machine/ }).click()
      await page.locator('.clip, [data-clip]').first().waitFor()
      await page.screenshot({ path: '/opt/cursor/artifacts/arrange-after-pads-390.png' })
      await page.close()
    } finally {
      web.kill('SIGTERM')
      await browser.close()
    }
  }, 180000)
})
