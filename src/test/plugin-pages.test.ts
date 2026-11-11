import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../audio/plugins/catalog'

const VIEWPORTS = [
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'fold-476x752', width: 476, height: 752 },
  { name: 'fold-880x1000', width: 880, height: 1000 },
  { name: 'computer-1440x900', width: 1440, height: 900 },
  { name: 'phone-land-844x390', width: 844, height: 390 },
]

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

async function openPlugin(page: Page, pluginId: string) {
  await page.evaluate((id) => {
    const store = (window as unknown as {
      __cueharbor: {
        store: {
          project: { tracks: { id: string; type: string }[] }
          track: (id: string) => { plugins: { id: string; pluginId: string }[] } | undefined
          addPlugin: (trackId: string, pluginId: string) => void
          focusPlugin: (trackId: string | null, pluginId?: string | null) => void
          selectTrack: (id: string) => void
          insertScaler: (id?: string | null) => void
          closeScaler: () => void
          closePads: () => void
          closeSteps: () => void
          addQuickTrack: (choice: string) => string | null
          openSteps: (id: string) => void
          showPads: (id: string) => void
          openPatch: (id: string) => void
        }
      }
    }).__cueharbor.store
    store.focusPlugin(null)
    store.closeScaler()
    store.closePads()
    store.closeSteps()
    const midi = store.project.tracks.find((track) => track.type === 'midi') ?? store.project.tracks[0]
    const audio = store.project.tracks.find((track) => track.type === 'audio') ?? midi
    if (id === 'scaler') {
      store.insertScaler(midi.id)
      return
    }
    if (id === 'pads') {
      const host = store.addQuickTrack('pads')
      if (host) store.showPads(host)
      return
    }
    if (id === 'steps') {
      const host = store.addQuickTrack('steps')
      if (host) store.openSteps(host)
      return
    }
    if (id === 'synth') {
      store.selectTrack(midi.id)
      store.addPlugin(midi.id, 'synth')
      return
    }
    const track = id === 'tune' ? audio : midi
    store.selectTrack(track.id)
    const existing = store.track(track.id)?.plugins.find((plugin) => plugin.pluginId === id)
    if (!existing) store.addPlugin(track.id, id)
    const plugin = store.track(track.id)?.plugins.find((item) => item.pluginId === id)
    if (plugin) store.focusPlugin(track.id, plugin.id)
  }, pluginId)
}

function rowGaps(page: Page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-plugin-root]')] as HTMLElement[]
    const root = roots[roots.length - 1]
    if (!root) return []
    const visible = (el: Element) => {
      if ((el as HTMLElement).closest('[hidden]')) return false
      const css = getComputedStyle(el)
      if (css.display === 'none' || css.visibility === 'hidden') return false
      const rect = el.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1
    }
    const controls = [...root.querySelectorAll('button, select, input')].filter(visible)
    const rows: { top: number; bottom: number }[] = []
    for (const el of controls) {
      const rect = el.getBoundingClientRect()
      const row = rows.find((item) => Math.abs(item.top - rect.top) < 14)
      if (row) {
        row.top = Math.min(row.top, rect.top)
        row.bottom = Math.max(row.bottom, rect.bottom)
      } else rows.push({ top: rect.top, bottom: rect.bottom })
    }
    rows.sort((a, b) => a.top - b.top)
    const gaps: string[] = []
    const nodes = [...root.querySelectorAll('*')].filter(visible)
    for (let index = 1; index < rows.length; index += 1) {
      const gap = rows[index].top - rows[index - 1].bottom
      if (gap <= 24) continue
      const filled = nodes.some((el) => {
        if (controls.some((control) => control === el || control.contains(el))) return false
        const box = el.getBoundingClientRect()
        return box.height > 8 && box.top >= rows[index - 1].bottom - 2 && box.bottom <= rows[index].top + 2
      })
      if (!filled) gaps.push(String(Math.round(gap)))
    }
    return gaps
  })
}

function measure(page: Page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-plugin-root]')] as HTMLElement[]
    const root = roots[roots.length - 1]
    if (!root) return null
    const outside: string[] = []
    const box = root.getBoundingClientRect()
    for (const el of root.querySelectorAll('button, select, input')) {
      const node = el as HTMLElement
      if (node.closest('[hidden]')) continue
      const css = getComputedStyle(node)
      if (css.display === 'none' || css.visibility === 'hidden') continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      if (rect.bottom > box.bottom + 2 || rect.top < box.top - 2) {
        outside.push((node.getAttribute('aria-label') || node.textContent || node.tagName).replace(/\s+/g, ' ').trim().slice(0, 40))
      }
    }
    return {
      scroll: root.scrollHeight - root.clientHeight,
      outside: outside.slice(0, 8),
      tabs: [...root.querySelectorAll('[data-plugin-tab]')].map((tab) => tab.getAttribute('data-plugin-tab')),
      select: !!root.querySelector('[data-plugin-pages] select, .plugin-page-menu select'),
    }
  })
}

describe('plugin pages do not scroll', () => {
  it('opens every plugin at every viewport with the body on one screen', async () => {
    const port = 5221
    const url = `http://127.0.0.1:${port}/`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, web)
      browser = await chromium.launch({ headless: true })
      const ids = [...new Set(CATALOG.map((plugin) => plugin.id))]
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
        page.on('pageerror', (error) => { throw new Error(`${viewport.name} ${error.message}`) })
        page.setDefaultTimeout(5000)
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => {
          const store = (window as unknown as { __cueharbor?: { store?: { project?: { tracks?: { name: string }[] } } } }).__cueharbor?.store
          return !!store?.project?.tracks?.some((track) => track.name === 'Keys')
        })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.waitForTimeout(1200)
        for (const id of ids) {
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
          await openPlugin(page, id)
          await page.waitForTimeout(800)
          if (errors.length) throw new Error(`${viewport.name} ${id} ${errors.join(' | ')}`)
          const root = page.locator('[data-plugin-root]').last()
          try {
            await root.waitFor({ timeout: 3000 })
          } catch (error) {
            const state = await page.evaluate(() => {
              const store = (window as unknown as { __cueharbor: { store: { pluginFocus: unknown; project: { tracks: { name: string; type: string; plugins: { pluginId: string }[] }[] } } } }).__cueharbor.store
              return { focus: store.pluginFocus, tracks: store.project.tracks.map((track) => ({ name: track.name, type: track.type, plugins: track.plugins.map((plugin) => plugin.pluginId) })) }
            })
            throw new Error(`${viewport.name} ${id} ${JSON.stringify(state)} ${(error as Error).message}`)
          }
          const handle = await root.elementHandle()
          if (!handle) throw new Error(`${viewport.name} ${id} missing root`)
          const box = await measure(page)
          if (!box) {
            const html = await page.evaluate(() => ({
              roots: document.querySelectorAll('[data-plugin-root]').length,
              overlays: [...document.querySelectorAll('[data-screen-overlay]')].map((node) => node.getAttribute('aria-label')),
              text: document.body.innerText.slice(0, 300),
            }))
            throw new Error(`${viewport.name} ${id} ${JSON.stringify(html)}`)
          }
          expect(box!.scroll, `${viewport.name} ${id} scroll ${box!.outside.join(', ')}`).toBeLessThanOrEqual(2)
          expect(box!.outside, `${viewport.name} ${id}`).toEqual([])
          if (viewport.width === 390) expect(await rowGaps(page), `${viewport.name} ${id} gaps`).toEqual([])
          const tabCount = await handle.evaluate((node) => node.querySelectorAll('[data-plugin-tab]').length)
          if (tabCount > 1) {
            const before = await handle.evaluate((node) => node.querySelector('[data-plugin-page]:not([hidden])')?.getAttribute('data-plugin-page') ?? '')
            await handle.evaluate((node) => {
              const tab = node.querySelectorAll('[data-plugin-tab]')[1] as HTMLButtonElement | undefined
              tab?.click()
            })
            await page.waitForTimeout(40)
            const after = await page.evaluate(() => {
              const root = [...document.querySelectorAll('[data-plugin-root]')].at(-1)
              return root?.querySelector('[data-plugin-page]:not([hidden])')?.getAttribute('data-plugin-page') ?? ''
            })
            const pressed = await page.evaluate(() => {
              const root = [...document.querySelectorAll('[data-plugin-root]')].at(-1)
              return root?.querySelectorAll('[data-plugin-tab]')[1]?.getAttribute('aria-selected') ?? ''
            })
            if (before && after) expect(after, `${viewport.name} ${id} tab`).not.toBe(before)
            else expect(pressed, `${viewport.name} ${id} tab`).toBe('true')
            const next = await measure(page)
            expect(next!.scroll, `${viewport.name} ${id} after tab`).toBeLessThanOrEqual(2)
            expect(next!.outside, `${viewport.name} ${id} after tab`).toEqual([])
            if (viewport.width === 390) expect(await rowGaps(page), `${viewport.name} ${id} tab gaps`).toEqual([])
            await handle.evaluate((node) => {
              const tab = node.querySelector('[data-plugin-tab]') as HTMLButtonElement | null
              tab?.click()
            })
          } else if (box!.select) {
            const select = page.locator('[data-plugin-root] .plugin-page-menu select').first()
            const values = await select.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
            if (values.length > 1) {
              await select.selectOption(values[1])
              const next = await measure(page)
              expect(next!.scroll, `${viewport.name} ${id} section`).toBeLessThanOrEqual(2)
              expect(next!.outside, `${viewport.name} ${id} section`).toEqual([])
              await select.selectOption(values[0])
            }
          }
          if (id === 'scaler' && viewport.width === 390) {
            await handle.evaluate((node) => {
              const tab = [...node.querySelectorAll('[data-plugin-tab]')].find((item) => item.getAttribute('data-plugin-tab') === 'options') as HTMLButtonElement | undefined
              tab?.click()
            })
            await page.waitForTimeout(40)
            const options = await measure(page)
            expect(options!.scroll, 'scaler options scroll').toBeLessThanOrEqual(2)
            expect(options!.outside, `scaler options ${options!.outside.join(', ')}`).toEqual([])
            expect(await rowGaps(page), 'scaler options gaps').toEqual([])
          }
        }
        await page.evaluate(() => {
          const store = (window as unknown as { __cueharbor: { store: { focusPlugin: (trackId: string | null) => void; closeScaler: () => void; closePads: () => void; closeSteps: () => void; patchTrackId: string | null; openPatch: (id: string) => void } } }).__cueharbor.store
          store.focusPlugin(null)
          store.closeScaler()
          store.closePads()
          store.closeSteps()
          if (store.patchTrackId) store.openPatch(store.patchTrackId)
        })
        await page.locator('[data-plugin-root]').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined)
        const phoneShell = await page.locator('.shell.phone').count()
        if (phoneShell) {
          await page.locator('.track-more').first().click()
          await page.locator('#track-options').getByRole('button', { name: 'Add plugin', exact: true }).click()
          await page.locator('.insert-menu button').first().waitFor()
          expect(await page.locator('.insert-menu button').count(), `${viewport.name} inserts`).toBeGreaterThan(3)
          expect(await page.locator('[data-arrange-plugins="toggle"]').count(), `${viewport.name} plugins door`).toBe(0)
        } else {
          await page.locator('[data-arrange-plugins="toggle"]').click()
          await page.locator('[data-plugins-panel="open"]').waitFor()
          await page.evaluate(() => {
            const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Add Plugin') as HTMLButtonElement | undefined
            button?.click()
          })
          await page.waitForTimeout(50)
          const drawer = await page.locator('.plugins-drawer').evaluate((node) => {
            const root = node as HTMLElement
            return root.scrollHeight - root.clientHeight
          })
          expect(drawer, `${viewport.name} drawer`).toBeLessThanOrEqual(2)
        }
        await page.close()
      }
    } finally {
      await browser?.close()
      if (web.pid) {
        try { process.kill(-web.pid, 'SIGTERM') } catch { /* already exited */ }
      }
    }
  }, 300000)
})
