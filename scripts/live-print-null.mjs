import { chromium } from 'playwright'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
page.setDefaultTimeout(120000)
page.on('pageerror', (error) => console.error('PAGE', error.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('CONSOLE', msg.text())
})
await page.goto(process.env.NULL_URL || 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
const table = await page.evaluate(async () => {
  const mod = await import('/src/test/livePrintHarness.ts')
  return mod.runLivePrintNull()
})
console.log(JSON.stringify(table, null, 2))
await browser.close()
