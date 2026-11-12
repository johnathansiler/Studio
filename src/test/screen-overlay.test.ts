import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { beforeEach, describe, expect, it } from 'vitest'
import { closeAllOverlays, onViewTab, overlayCount, registerOverlay, resetOverlayRegistry } from '../ui/overlayHost'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = '/opt/cursor/artifacts'

describe('close every overlay from a view tab', () => {
  beforeEach(() => resetOverlayRegistry())

  it('runs every registered closer, including ones added later', () => {
    const closed: string[] = []
    const stop = registerOverlay(() => closed.push('menu'))
    registerOverlay(() => closed.push('scaler'))
    closeAllOverlays()
    expect(closed).toEqual(['menu', 'scaler'])
    expect(overlayCount()).toBe(2)
    stop()
    closed.length = 0
    registerOverlay(() => closed.push('steps'))
    closeAllOverlays()
    expect(closed).toContain('scaler')
    expect(closed).toContain('steps')
    expect(closed).not.toContain('menu')
  })

  it('closes overlays and releases a locked keyboard orientation', () => {
    const calls: string[] = []
    registerOverlay(() => calls.push('overlay'))
    onViewTab({
      keyboardOpen: true,
      orientationLocked: true,
      hideKeyboard: () => calls.push('keyboard'),
      releaseOrientation: () => calls.push('release'),
    })
    expect(calls).toEqual(['overlay', 'keyboard', 'release'])
  })

  it('still closes overlays when the current tab is tapped and orientation is free', () => {
    const calls: string[] = []
    registerOverlay(() => calls.push('overlay'))
    onViewTab({
      keyboardOpen: false,
      orientationLocked: false,
      hideKeyboard: () => calls.push('keyboard'),
      releaseOrientation: () => calls.push('release'),
    })
    expect(calls).toEqual(['overlay'])
  })

  it('wires the view tabs through the shared helper', () => {
    const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8')
    expect(app).toContain('onViewTab(')
    expect(app).toContain('dismissForTab()')
    expect(app).toContain("orientationLocked: keysMode.current === 'locked'")
    expect(app).toContain('releaseOrientation()')
    expect(app).toContain('useScreenOverlay(')
  })
})

const layouts = [
  { name: 'phone', width: 390, height: 844, shell: 'shell studio phone' },
  { name: 'fold-cover', width: 476, height: 752, shell: 'shell studio phone' },
  { name: 'unfolded', width: 880, height: 1000, shell: 'shell studio fold' },
  { name: 'computer', width: 1440, height: 900, shell: 'shell studio' },
  { name: 'phone-land', width: 844, height: 390, shell: 'shell studio phone land' },
]

function cssBundle(buttonTiers: string) {
  return ['src/styles.css', 'src/ui/premium.css', 'src/ui/remoteFixes.css', 'src/ui/buttonTiers.css']
    .map((file) => file.endsWith('buttonTiers.css') ? buttonTiers : readFileSync(resolve(root, file), 'utf8'))
    .join('\n')
}

function tabBarHtml() {
  return `<header class="topbar">
    <button type="button" class="menu-btn">Menu</button>
    <div class="brand"><h1>CueHarbor</h1></div>
    <input class="project-name" value="Song" aria-label="Project name" />
    <div class="views">
      <button type="button" class="collab-tab">Collab</button>
      <button type="button" class="active">Arrange</button>
      <button type="button">Mix</button>
    </div>
    <button type="button" class="unstuck-btn">Ideas</button>
  </header>`
}

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'process exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'server did not start')
}

async function tabGeometry(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.views') as HTMLElement
    const buttons = [...bar.querySelectorAll('button')] as HTMLButtonElement[]
    const view = bar.getBoundingClientRect()
    const boxes = buttons.map((button) => {
      const box = button.getBoundingClientRect()
      const style = getComputedStyle(button)
      return {
        label: (button.textContent || '').replace(/\s+/g, ' ').trim(),
        width: box.width,
        height: box.height,
        active: button.classList.contains('active') || button.classList.contains('collab-tab') && button.classList.contains('active'),
        fontSize: style.fontSize,
        shadow: style.boxShadow,
        background: style.backgroundColor,
      }
    })
    return { viewLeft: view.left, viewRight: view.right, viewWidth: view.width, vw: window.innerWidth, boxes }
  })
}

function expectFullRow(geometry: Awaited<ReturnType<typeof tabGeometry>>, minHeight: number) {
  expect(geometry.viewLeft).toBeLessThanOrEqual(16)
  expect(geometry.viewRight).toBeGreaterThanOrEqual(geometry.vw - 16)
  expect(geometry.viewWidth).toBeGreaterThanOrEqual(geometry.vw - 32)
  const widths = geometry.boxes.map((box) => box.width)
  const widest = Math.max(...widths)
  const narrowest = Math.min(...widths)
  expect(widest - narrowest).toBeLessThanOrEqual(2)
  for (const box of geometry.boxes) {
    expect(box.height).toBeGreaterThanOrEqual(minHeight)
    expect(box.shadow).not.toBe('none')
  }
  const active = geometry.boxes.find((box) => box.label === 'Arrange')
  expect(active?.background).toBe('rgb(115, 196, 143)')
}

async function assertOverlay(page: Page) {
  const result = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.views button')] as HTMLElement[]
    const tabHits = tabs.map((tab) => {
      const box = tab.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { label: (tab.textContent || '').replace(/\s+/g, ' ').trim(), ok: !!hit && (hit === tab || tab.contains(hit)) }
    })
    const view = document.querySelector('.views')!.getBoundingClientRect()
    const overlays = [...document.querySelectorAll('[data-screen-overlay]')] as HTMLElement[]
    const vw = window.innerWidth
    const vh = window.innerHeight
    const boxes = overlays.map((node) => {
      const box = node.getBoundingClientRect()
      return {
        top: box.top,
        left: box.left,
        right: box.right,
        bottom: box.bottom,
        phoneSheet: node.classList.contains('phone-sheet') || node.classList.contains('guide-sheet'),
      }
    })
    const y = Math.min(vh - 4, (view.bottom + vh) / 2)
    const hit = document.elementFromPoint(vw / 2, y)
    const covered = overlays.some((node) => hit === node || node.contains(hit))
    const phone = !!document.querySelector('.shell.phone')
    const transport = document.querySelector('.transport')?.getBoundingClientRect()
    const bar = document.querySelector('.tool-slot')?.getBoundingClientRect()
    const pill = overlays
      .flatMap((node) => [...node.querySelectorAll('button.overlay-close, .step-close, .scaler-close, .mpc-close, .browser-close, .song-close')])
      .map((node) => node.getBoundingClientRect())
    return {
      tabHits,
      viewBottom: view.bottom,
      boxes,
      vw,
      vh,
      covered,
      phone,
      transportBottom: transport?.bottom ?? null,
      barTop: bar?.top ?? null,
      pills: pill.map((box) => ({ width: box.width, height: box.height })),
    }
  })
  for (const tab of result.tabHits) expect(tab.ok, tab.label).toBe(true)
  expect(result.boxes.length).toBeGreaterThan(0)
  const sheets = result.phone ? result.boxes.filter((box) => box.phoneSheet) : []
  const full = result.boxes.filter((box) => !sheets.includes(box))
  for (const box of sheets) {
    expect(box.top).toBeGreaterThanOrEqual(result.viewBottom - 2)
    if (result.transportBottom != null) expect(box.top).toBeGreaterThanOrEqual(result.transportBottom - 2)
    if (result.barTop != null) expect(box.bottom).toBeLessThanOrEqual(result.barTop + 2)
  }
  for (const box of full) {
    expect(box.left).toBeLessThanOrEqual(1)
    expect(box.right).toBeGreaterThanOrEqual(result.vw - 1)
    expect(box.bottom).toBeGreaterThanOrEqual(result.vh - 1)
    expect(Math.abs(box.top - result.viewBottom)).toBeLessThanOrEqual(3)
  }
  if (full.length) expect(result.covered).toBe(true)
  expect(result.pills.length).toBeGreaterThan(0)
  for (const pill of result.pills) {
    expect(pill.width).toBeGreaterThanOrEqual(40)
    expect(pill.height).toBeGreaterThanOrEqual(40)
  }
}

async function assertDocked(page: Page) {
  const result = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.views button')] as HTMLElement[]
    const tabHits = tabs.map((tab) => {
      const box = tab.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { label: (tab.textContent || '').replace(/\s+/g, ' ').trim(), ok: !!hit && (hit === tab || tab.contains(hit)) }
    })
    const view = document.querySelector('.views')!.getBoundingClientRect()
    const menu = document.querySelector('.anchored-menu[data-menu-size="dock"]') as HTMLElement
    const box = menu.getBoundingClientRect()
    return {
      tabHits,
      viewBottom: view.bottom,
      top: box.top,
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      overlay: menu.hasAttribute('data-screen-overlay'),
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
  })
  for (const tab of result.tabHits) expect(tab.ok, tab.label).toBe(true)
  expect(result.overlay).toBe(false)
  expect(result.top).toBeGreaterThanOrEqual(result.viewBottom - 2)
  expect(result.right - result.left).toBeLessThan(result.vw - 16)
  expect(result.bottom).toBeLessThanOrEqual(result.vh + 1)
}

async function settleClosed(page: Page) {
  await page.waitForFunction(() => {
    return document.querySelectorAll('[data-screen-overlay]').length === 0
      && document.querySelectorAll('.anchored-menu[data-menu-size="dock"]').length === 0
  })
}

describe('screen overlays leave the view tabs free', () => {
  it('opens each major overlay under the tabs and restores the full-width tab row', async () => {
    mkdirSync(artifacts, { recursive: true })
    const beforeTiers = execSync('git show 872ae1c:src/ui/buttonTiers.css', { encoding: 'utf8' })
    const port = 4393
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
    }))
    try {
      const beforePage = await browser.newPage()
      for (const layout of layouts) {
        await beforePage.setViewportSize({ width: layout.width, height: layout.height })
        await beforePage.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #101614; width: ${layout.width}px; height: ${layout.height}px; }
          ${cssBundle(beforeTiers)}
        </style></head><body><div class="${layout.shell}" style="width:${layout.width}px;height:${layout.height}px">${tabBarHtml()}</div></body></html>`, { waitUntil: 'load' })
        await beforePage.screenshot({ path: `${artifacts}/tabs-before-${layout.name}.png` })
      }
      await beforePage.close()

      await waitForServer(url, web)
      const page = await browser.newPage()
      for (const layout of layouts) {
        await page.setViewportSize({ width: layout.width, height: layout.height })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        const tabs = await tabGeometry(page)
        if (layout.name === 'phone-land') {
          const widths = tabs.boxes.map((box) => box.width)
          expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2)
          for (const box of tabs.boxes) {
            expect(box.height).toBeGreaterThanOrEqual(36)
            expect(box.width).toBeGreaterThan(70)
            expect(box.shadow).not.toBe('none')
          }
          expect(tabs.boxes.find((box) => box.label === 'Arrange')?.background).toBe('rgb(115, 196, 143)')
        } else {
          expectFullRow(tabs, layout.name === 'unfolded' ? 44 : 40)
          expect(tabs.boxes.every((box) => box.fontSize === '13px')).toBe(true)
        }
        await page.screenshot({ path: `${artifacts}/tabs-after-${layout.name}.png` })

        const openers: { name: string; open: () => Promise<void>; shot?: boolean }[] = [
          { name: 'menu', shot: true, open: async () => { await page.locator('.menu-btn').click() } },
          { name: 'song', open: async () => {
            const setup = page.locator('.arrange-panels').getByRole('button', { name: /^Setup/ })
            if (await setup.count()) await setup.click()
            else await page.getByRole('button', { name: /^Setup/ }).click()
          } },
          { name: 'add-track', open: async () => { await page.getByRole('button', { name: /^Add Track/ }).click() } },
          {
            name: 'plugin',
            open: async () => {
              await page.evaluate(() => {
                const store = (window as unknown as { __cueharbor: { store: { project: { tracks: { id: string; type: string }[] }; track: (id: string) => { plugins: { id: string; pluginId: string }[] }; addPlugin: (id: string, pluginId: string) => void; focusPlugin: (trackId: string, pluginId: string) => void; selectTrack: (id: string) => void } } }).__cueharbor.store
                const track = store.project.tracks.find((item) => item.type === 'midi') ?? store.project.tracks[0]
                store.selectTrack(track.id)
                store.addPlugin(track.id, 'eq')
                const plugin = store.track(track.id).plugins.find((item) => item.pluginId === 'eq')
                if (plugin) store.focusPlugin(track.id, plugin.id)
              })
            },
          },
          {
            name: 'presets',
            open: async () => {
              await page.evaluate(() => {
                const store = (window as unknown as { __cueharbor: { store: { project: { tracks: { id: string; type: string }[] }; track: (id: string) => { plugins: { id: string; pluginId: string }[] }; addPlugin: (id: string, pluginId: string) => void; focusPlugin: (trackId: string, pluginId: string) => void; selectTrack: (id: string) => void } } }).__cueharbor.store
                const track = store.project.tracks.find((item) => item.type === 'midi') ?? store.project.tracks[0]
                store.selectTrack(track.id)
                if (!store.track(track.id).plugins.some((item) => item.pluginId === 'eq')) store.addPlugin(track.id, 'eq')
                const plugin = store.track(track.id).plugins.find((item) => item.pluginId === 'eq')
                if (plugin) store.focusPlugin(track.id, plugin.id)
              })
              await page.locator('[data-screen-overlay]').first().waitFor()
              await page.getByRole('button', { name: 'Presets' }).click()
            },
          },
          {
            name: 'scaler',
            open: async () => {
              await page.evaluate(() => {
                const store = (window as unknown as { __cueharbor: { store: { insertScaler: (id?: string | null) => void } } }).__cueharbor.store
                store.insertScaler(null)
              })
            },
          },
          {
            name: 'tune',
            shot: layout.name === 'computer' || layout.name === 'phone',
            open: async () => {
              await page.evaluate(() => {
                const store = (window as unknown as { __cueharbor: { store: { project: { tracks: { id: string; type: string }[] }; track: (id: string) => { plugins: { id: string; pluginId: string }[] }; addPlugin: (id: string, pluginId: string) => void; focusPlugin: (trackId: string, pluginId: string) => void; selectTrack: (id: string) => void } } }).__cueharbor.store
                const track = store.project.tracks.find((item) => item.type === 'audio') ?? store.project.tracks[0]
                store.selectTrack(track.id)
                if (!store.track(track.id).plugins.some((item) => item.pluginId === 'tune')) store.addPlugin(track.id, 'tune')
                const plugin = store.track(track.id).plugins.find((item) => item.pluginId === 'tune')
                if (plugin) store.focusPlugin(track.id, plugin.id)
              })
            },
          },
          {
            name: 'steps',
            shot: true,
            open: async () => {
              await page.evaluate(() => {
                const store = (window as unknown as { __cueharbor: { store: { addQuickTrack: (choice: string) => string | null; openSteps: (id: string) => void } } }).__cueharbor.store
                const id = store.addQuickTrack('steps')
                if (id) store.openSteps(id)
              })
            },
          },
          {
            name: 'pads',
            shot: layout.name === 'phone-land' || layout.name === 'unfolded',
            open: async () => {
              await page.evaluate(() => {
                const store = (window as unknown as { __cueharbor: { store: { addQuickTrack: (choice: string) => string | null; showPads: (id: string) => void } } }).__cueharbor.store
                const id = store.addQuickTrack('pads')
                if (id) store.showPads(id)
              })
            },
          },
        ]
        if (layout.name === 'phone') {
          openers.splice(2, 0, {
            name: 'tools',
            open: async () => { await page.getByRole('button', { name: 'Tools', exact: true }).click() },
          })
        }

        for (const opener of openers) {
          await opener.open()
          if (opener.name === 'tools') {
            const row = page.locator('#tool-choices[data-tool-row="open"]')
            await row.waitFor()
            expect(await row.getAttribute('data-screen-overlay')).toBeNull()
            const box = await row.boundingBox()
            const bar = await page.locator('.tool-slot').boundingBox()
            expect(box).toBeTruthy()
            expect(box!.height, `${layout.name} tools`).toBeGreaterThan(40)
            expect(box!.height, `${layout.name} tools`).toBeLessThan(72)
            if (bar) {
              expect(box!.y).toBeGreaterThanOrEqual(bar.y - 1)
              expect(box!.y + box!.height).toBeLessThanOrEqual(bar.y + bar.height + 1)
            }
            await page.getByRole('button', { name: 'Tools', exact: true }).click()
            await row.waitFor({ state: 'detached' })
            await settleClosed(page)
            continue
          }
          if (opener.name === 'song') {
            const sheet = page.locator('#arrange-setup[data-bottom-sheet="open"]')
            await sheet.waitFor()
            expect(await sheet.getAttribute('data-screen-overlay')).toBeNull()
            const box = await sheet.boundingBox()
            const bar = await page.locator('.tool-slot').boundingBox()
            const transport = await page.locator('.transport').boundingBox()
            expect(box).toBeTruthy()
            expect(box!.height, `${layout.name} ${opener.name}`).toBeGreaterThan(48)
            expect(box!.height).toBeLessThan(layout.height * 0.85)
            if (bar) expect(box!.y + box!.height).toBeLessThanOrEqual(bar.y + 4)
            if (transport) expect(box!.y).toBeGreaterThanOrEqual((transport.y + transport.height) - 4)
            const close = sheet.locator('.overlay-close')
            const closeBox = await close.boundingBox()
            expect(closeBox!.height).toBeGreaterThanOrEqual(44)
            expect(closeBox!.width).toBeGreaterThanOrEqual(44)
            await page.getByRole('button', { name: /^Arrange/ }).first().click()
            await sheet.waitFor({ state: 'detached' })
            await settleClosed(page)
            continue
          }
          await page.waitForFunction(() => {
            return document.querySelector('[data-screen-overlay]')
              || document.querySelector('.anchored-menu[data-menu-size="dock"]')
          }, undefined, { timeout: 8000 })
          if (await page.locator('[data-screen-overlay]').count()) await assertOverlay(page)
          else await assertDocked(page)
          if (opener.shot) await page.screenshot({ path: `${artifacts}/overlay-${opener.name}-${layout.name}.png` })
          await page.getByRole('button', { name: /^Arrange/ }).first().click()
          await settleClosed(page)
        }

        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        const phoneShell = layout.shell.split(' ').includes('phone')
        const browserToggle = phoneShell
          ? page.getByRole('button', { name: 'Browse', exact: true })
          : page.locator('.arrange-panels').getByRole('button', { name: /^Browser/ })
        const docked = page.locator('[data-playlist-browser="open"]')
        if (await docked.count() === 0) await browserToggle.click()
        await docked.first().waitFor()
        expect(await docked.first().getAttribute('data-screen-overlay')).toBeNull()
        const dockBox = await docked.first().boundingBox()
        const arrangeBox = await page.locator('.arrange').first().boundingBox()
        if (layout.shell.split(' ').includes('phone')) {
          await page.locator('.arrange-stage.browser-bottom [data-bottom-sheet="open"]').waitFor()
          const bar = await page.locator('.tool-slot').boundingBox()
          expect(dockBox!.x).toBeLessThanOrEqual(2)
          expect(dockBox!.x + dockBox!.width).toBeGreaterThanOrEqual(layout.width - 4)
          expect(arrangeBox!.width).toBeGreaterThan(layout.width * 0.85)
          if (bar) expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(bar.y + 2)
        } else {
          await page.locator('.playlist-frame[data-push="on"]').waitFor()
          expect(dockBox && arrangeBox && dockBox.x + dockBox.width <= arrangeBox.x + 2).toBe(true)
        }
        await page.screenshot({ path: `${artifacts}/browser-arrange-${layout.name}.png` })
        await page.getByRole('button', { name: /^Filter/ }).first().click()
        const filterMenu = page.locator('.anchored-menu.sound-filter-menu')
        await filterMenu.waitFor()
        const stack = await page.evaluate(() => {
          const menu = document.querySelector('.anchored-menu.sound-filter-menu') as HTMLElement
          const browser = document.querySelector('[data-playlist-browser="open"]') as HTMLElement
          const tabs = document.querySelector('.views') as HTMLElement
          const box = menu.getBoundingClientRect()
          const top = document.elementFromPoint(box.left + Math.min(24, box.width / 2), box.top + Math.min(16, box.height / 2))
          return {
            menuZ: Number(getComputedStyle(menu).zIndex),
            tabZ: Number(getComputedStyle(tabs).zIndex),
            menuTop: box.top,
            tabsBottom: tabs.getBoundingClientRect().bottom,
            hit: menu === top || menu.contains(top),
            covered: browser.contains(top),
          }
        })
        expect(stack.menuZ).toBeGreaterThan(360)
        expect(stack.menuZ).toBeLessThan(stack.tabZ)
        expect(stack.menuTop).toBeGreaterThanOrEqual(stack.tabsBottom - 1)
        expect(stack.hit).toBe(true)
        expect(stack.covered).toBe(false)
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: /^Mix/ }).first().click()
        await page.locator('.workspace[data-push="on"] .shell-browser [data-playlist-browser="open"]').waitFor()
        await page.screenshot({ path: `${artifacts}/browser-mix-${layout.name}.png` })
        await page.getByRole('button', { name: /^Arrange/ }).first().click()

        await page.locator('.menu-btn').click()
        await page.locator('[data-screen-overlay], .anchored-menu[data-open="true"]').first().waitFor()
        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        await settleClosed(page)
        expect(await page.getByRole('button', { name: /^Arrange/ }).first().getAttribute('class')).toContain('active')

        await page.locator('.menu-btn').click()
        await page.locator('[data-screen-overlay], .anchored-menu[data-open="true"]').first().waitFor()
        await page.getByRole('button', { name: /^Mix/ }).first().click()
        await settleClosed(page)
        expect(await page.getByRole('button', { name: /^Mix/ }).first().getAttribute('class')).toContain('active')
        await page.getByRole('button', { name: /^Collab/ }).first().click()
        await page.locator('[data-collab-panel="open"]').waitFor()
        await page.getByRole('button', { name: /^Arrange/ }).first().click()
      }
      await page.close()
    } finally {
      try { process.kill(-web.pid!, 'SIGTERM') } catch { web.kill('SIGTERM') }
      await browser.close()
    }
  }, 180000)
})
