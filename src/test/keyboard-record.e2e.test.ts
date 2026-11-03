import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'

describe('keyboard dock recording', () => {
  it('arms a MIDI track, records dock keys, and keeps the notes', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const server = await createServer({
      configFile: resolve(import.meta.dirname, '../../vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await server.listen()
    const address = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.config.server.port}`
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
      await page.goto(`${address}src/test/keyboard-record.harness.html`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.mini-pad.natural')
      await page.click('#record')
      const key = page.locator('.mini-pad.natural').first()
      const box = await key.boundingBox()
      if (!box) throw new Error('dock key has no box')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.up()
      await page.click('#stop')
      await page.waitForFunction(() => Number(document.querySelector('#notes')?.getAttribute('data-count') || 0) > 1)
      const count = Number(await page.locator('#notes').getAttribute('data-count'))
      expect(count).toBeGreaterThan(1)
      await page.screenshot({ path: '/opt/cursor/artifacts/keyboard-record-notes.png' })
      await page.close()
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
