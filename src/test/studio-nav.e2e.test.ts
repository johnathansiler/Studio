import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'process exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'server did not start')
}

async function addTrack(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Add Track' }).click()
  await page.getByRole('button', { name }).click()
}

describe('studio navigation', () => {
  it('shows three tabs, a left Menu, four track kinds, and column strips on a phone', async () => {
    const port = 4317
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, web)
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1280, height: 800 },
      ]) {
        const page = await browser.newPage({ viewport })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        const tabs = await page.locator('.views button').evaluateAll((nodes) => nodes.map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()))
        expect(tabs).toEqual(['Collab', 'Arrange', 'Mix'])
        const place = await page.evaluate(() => {
          const bar = document.querySelector('.topbar')!.getBoundingClientRect()
          const menu = document.querySelector('.menu-btn')!.getBoundingClientRect()
          const name = document.querySelector('.project-name')!.getBoundingClientRect()
          return { menuLeft: menu.left, menuHeight: menu.height, menuWidth: menu.width, barLeft: bar.left, barMid: bar.left + bar.width / 2, nameLeft: name.left }
        })
        expect(place.menuLeft).toBeLessThan(place.barMid)
        expect(place.menuLeft).toBeLessThanOrEqual(place.nameLeft)
        expect(place.menuHeight).toBeGreaterThanOrEqual(40)
        expect(place.menuWidth).toBeGreaterThanOrEqual(40)
        await page.close()
      }

      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('textbox', { name: 'Keys name' }).waitFor()
      expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)

      await addTrack(page, /Instrument\. Play keys/)
      await page.locator('[data-keyboard-dock="open"]').waitFor()
      await page.getByRole('textbox', { name: 'Instrument 1 name' }).waitFor()
      await page.locator('.keyboard-close').click()
      await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })

      await addTrack(page, /Step Sequencer\. Program beats/)
      await page.locator('[data-step-sequencer="open"]').waitFor()
      await page.getByRole('textbox', { name: 'Step Sequencer 1 name' }).waitFor()
      const kick = page.getByRole('button', { name: /Kick step 2\./ })
      await kick.click()
      expect(await kick.getAttribute('aria-pressed')).toBe('true')
      await page.locator('.step-close').click()
      await page.locator('[data-step-sequencer="open"]').waitFor({ state: 'detached' })

      await page.locator('.transport').getByRole('button', { name: /^More/ }).click()
      const click = page.getByRole('button', { name: /^Metronome/ }).first()
      if (await click.getAttribute('aria-pressed') === 'true') await click.click()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: /^Play/ }).first().click()
      await page.waitForFunction(() => {
        const host = window as unknown as {
          __seqProof?: { track: number; master: number; scale: number; lit: boolean }
          __cueharbor?: { engine: { levels: () => { master: number; tracks: Record<string, number> } }; store: { project: { tracks: { id: string; name: string }[] } } }
        }
        const hook = host.__cueharbor
        const track = hook?.store.project.tracks.find((item) => item.name === 'Step Sequencer 1')
        if (!hook || !track) return false
        const levels = hook.engine.levels()
        const head = document.querySelector(`.head[data-track="${track.id}"] .mini-meter i`) as HTMLElement | null
        const scale = Number(/scaleX\(([^)]+)\)/.exec(head?.style.transform || '')?.[1] || 0)
        const lit = document.querySelector(`.head[data-track="${track.id}"] .midi-activity`)?.getAttribute('data-lit') === '1'
        const proof = host.__seqProof ?? { track: 0, master: 0, scale: 0, lit: false }
        proof.track = Math.max(proof.track, levels.tracks[track.id] || 0)
        proof.master = Math.max(proof.master, levels.master || 0)
        proof.scale = Math.max(proof.scale, scale)
        proof.lit = proof.lit || lit
        host.__seqProof = proof
        return proof.track > 0.01 && proof.master > 0.01 && proof.scale > 0.02 && proof.lit
      }, undefined, { timeout: 12000 })

      await page.getByRole('button', { name: /^Mix/ }).first().click()
      await page.locator('.mixer-view[data-layout="columns"]').waitFor()
      expect(await page.getByRole('button', { name: /^Rows/ }).count()).toBe(0)
      expect(await page.getByRole('button', { name: /^Columns/ }).count()).toBe(0)
      await page.waitForFunction(() => {
        const strips = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')]
        const seq = strips.find((strip) => (strip.querySelector('h3')?.textContent || '').includes('Step Sequencer'))
        const meter = seq?.querySelector('.meter b') as HTMLElement | null
        const master = document.querySelector('.strip.master .meter b') as HTMLElement | null
        return Number.parseFloat(meter?.style.height || '0') > 2 && Number.parseFloat(master?.style.height || '0') > 2
      }, undefined, { timeout: 8000 })
      const mix = await page.evaluate(() => {
        const mixer = document.querySelector('.mixer') as HTMLElement
        const strips = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')]
        const seq = strips.find((strip) => (strip.querySelector('h3')?.textContent || '').includes('Step Sequencer'))
        const meter = seq?.querySelector('.meter b') as HTMLElement | null
        const master = document.querySelector('.strip.master .meter b') as HTMLElement | null
        return {
          sideBySide: strips.length > 1 && strips[1].getBoundingClientRect().left >= strips[0].getBoundingClientRect().right - 2,
          scroll: getComputedStyle(mixer).overflowX,
          trackMeter: Number.parseFloat(meter?.style.height || '0'),
          masterMeter: Number.parseFloat(master?.style.height || '0'),
        }
      })
      expect(mix.sideBySide).toBe(true)
      expect(mix.scroll === 'auto' || mix.scroll === 'scroll').toBe(true)
      expect(mix.trackMeter).toBeGreaterThan(2)
      expect(mix.masterMeter).toBeGreaterThan(2)
      const muted = await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor?: {
            engine: { levels: () => { master: number; tracks: Record<string, number> } }
            store: { project: { tracks: { id: string; name: string }[] }; updateTrack: (id: string, patch: { mute: boolean }) => void }
          }
        }).__cueharbor
        const track = hook?.store.project.tracks.find((item) => item.name === 'Step Sequencer 1')
        if (!hook || !track) return { track: 1, master: 1 }
        hook.store.updateTrack(track.id, { mute: true })
        let trackLevel = 0
        let master = 0
        for (let i = 0; i < 8; i++) {
          await new Promise((resolve) => setTimeout(resolve, 60))
          const levels = hook.engine.levels()
          trackLevel = Math.max(trackLevel, levels.tracks[track.id] || 0)
          master = Math.max(master, levels.master || 0)
        }
        return { track: trackLevel, master }
      })
      expect(muted.track).toBeLessThan(0.01)
      expect(muted.master).toBeLessThan(0.01)

      await page.getByRole('button', { name: /^Arrange/ }).first().click()
      await addTrack(page, /Beat Machine\. Pads/)
      await page.locator('[data-pads="plugin"]').waitFor()
      expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)
      await page.getByRole('button', { name: /Close Beat Machine/ }).click()
      await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

      await addTrack(page, /Audio \/ Vocal\. Record mic/)
      await page.getByRole('textbox', { name: 'Audio 1 name' }).waitFor()
      const armed = await page.evaluate(() => {
        const hook = (window as unknown as { __cueharbor?: { store: { project: { tracks: { name: string; armed: boolean; type: string }[] } } } }).__cueharbor
        return hook?.store.project.tracks.find((track) => track.name === 'Audio 1')
      })
      expect(armed?.type).toBe('audio')
      expect(armed?.armed).toBe(true)
    } finally {
      web.kill('SIGTERM')
      await browser.close()
    }
  }, 90000)
})
