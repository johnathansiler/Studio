import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/automation.css'].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

function strip(name: string, master = false) {
  const modes = ['Off', 'Read', 'Touch', 'Latch'].map((label, index) => (
    `<button type="button" class="${index === 1 ? 'on' : ''}" aria-pressed="${index === 1}">${label}</button>`
  )).join('')
  return `<div class="strip${master ? ' master' : ''}" data-track="${name}">
    <h3>${name}</h3>
    <div class="strip-auto" role="group" aria-label="${name} automation">${modes}</div>
    <div class="fader-row"><div class="meter"><b></b></div><input type="range" min="0" max="1" value="0.8" aria-label="${name} volume"></div>
  </div>`
}

function page(count: number) {
  const tracks = Array.from({ length: count }, (_, index) => strip(`Ch ${index + 1}`)).join('')
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; background: #121a16; }
  ${css}
</style>
</head>
<body>
<div class="shell studio">
  <div class="main-pane">
    <div class="mixer-view" style="--strip: 84px; height: 640px;">
      <div class="mixer">
        ${tracks}
        ${strip('Master', true)}
      </div>
    </div>
  </div>
</div>
</body>
</html>`
}

describe('mix layout', () => {
  it('starts the first strip at the left edge and fills the mixer', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch()
    try {
      const shots: { name: string; width: number; height: number; count: number; shell: string }[] = [
        { name: 'mix-desktop', width: 1280, height: 800, count: 3, shell: 'studio' },
        { name: 'mix-fold', width: 768, height: 900, count: 3, shell: 'fold studio' },
        { name: 'mix-phone', width: 390, height: 844, count: 8, shell: 'phone studio' },
      ]
      for (const shot of shots) {
        const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
        const html = pageHtml(shot.count).replace('class="shell studio"', `class="shell ${shot.shell}"`)
        await page.setContent(html, { waitUntil: 'load' })
        const box = await page.evaluate(() => {
          const mixer = document.querySelector('.mixer') as HTMLElement
          const strips = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')]
          const first = strips[0].getBoundingClientRect()
          const last = strips[strips.length - 1].getBoundingClientRect()
          const mix = mixer.getBoundingClientRect()
          const labels = [...document.querySelectorAll<HTMLElement>('.strip-auto button')].map((button) => {
            const text = button.getBoundingClientRect()
            const bounds = button.getBoundingClientRect()
            return {
              label: button.textContent,
              left: text.left,
              right: text.right,
              boxLeft: bounds.left,
              boxRight: bounds.right,
              scrollWidth: button.scrollWidth,
              clientWidth: button.clientWidth,
            }
          })
          return {
            mixLeft: mix.left,
            mixRight: mix.right,
            firstLeft: first.left,
            lastRight: last.right,
            scrollWidth: mixer.scrollWidth,
            clientWidth: mixer.clientWidth,
            labels,
          }
        })
        expect(box.firstLeft).toBeLessThanOrEqual(box.mixLeft + 1)
        expect(box.firstLeft).toBeGreaterThanOrEqual(box.mixLeft - 1)
        if (shot.count <= 3) expect(box.lastRight).toBeGreaterThanOrEqual(box.mixRight - 2)
        if (shot.count >= 8) expect(box.scrollWidth).toBeGreaterThan(box.clientWidth + 8)
        for (const label of box.labels) {
          expect(label.scrollWidth, label.label ?? '').toBeLessThanOrEqual(label.clientWidth + 1)
          expect(label.left, label.label ?? '').toBeGreaterThanOrEqual(label.boxLeft - 1)
          expect(label.right, label.label ?? '').toBeLessThanOrEqual(label.boxRight + 1)
        }
        await page.screenshot({ path: `/opt/cursor/artifacts/${shot.name}.png`, fullPage: true })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })
})

function pageHtml(count: number) {
  return page(count)
}
