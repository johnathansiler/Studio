import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { safetyCurve } from '../audio/level'

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '880x1000', width: 880, height: 1000 },
  { name: '1440x900', width: 1440, height: 900 },
] as const

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'preview exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(detail || 'preview did not start')
}

async function ensureDist() {
  if (existsSync('dist/index.html')) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['vite', 'build'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let detail = ''
    child.stdout?.on('data', (chunk) => { detail += String(chunk) })
    child.stderr?.on('data', (chunk) => { detail += String(chunk) })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(detail || 'build failed'))))
  })
}

async function openInstruments(page: Page) {
  const arrange = page.getByRole('button', { name: /^Arrange/ }).first()
  if (await arrange.count()) await arrange.click().catch(() => undefined)
  const browser = page.locator('[data-playlist-browser="open"]')
  if (await browser.count() === 0) await page.getByRole('button', { name: /^Browse/ }).first().click()
  await browser.getByRole('button', { name: 'My Library', exact: true }).waitFor()
}

describe('production instrument playback', () => {
  it('loads Yamaha and a bass, fetches samples, and reaches the speakers', async () => {
    await ensureDist()
    const port = 4700 + Math.floor(Math.random() * 200)
    const url = `http://127.0.0.1:${port}/`
    const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    const problems: string[] = []
    try {
      await waitForServer(url, child)
      const headers = await fetch(url)
      expect(headers.headers.get('cross-origin-embedder-policy')).toBe('credentialless')
      const page = await browser.newPage()
      await page.addInitScript(() => {
        const Native = window.AudioContext
        const probes: AnalyserNode[] = []
        function Wrapped(this: AudioContext, options?: AudioContextOptions) {
          const ctx = new Native(options)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 2048
          const proto = AudioNode.prototype as unknown as { connect: (this: AudioNode, ...args: unknown[]) => unknown }
          const connect = proto.connect
          proto.connect = function (this: AudioNode, ...args: unknown[]) {
            const result = connect.apply(this, args)
            if (args[0] === ctx.destination) {
              try { connect.call(this, analyser) } catch { /* the node may already be tied */ }
            }
            return result
          }
          probes.push(analyser)
          ;(window as unknown as { __outputProbe?: AnalyserNode[] }).__outputProbe = probes
          return ctx
        }
        Wrapped.prototype = Native.prototype
        window.AudioContext = Wrapped as unknown as typeof AudioContext
      })
      page.on('pageerror', (error) => problems.push(error.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push(msg.text())
      })
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await openInstruments(page)
        expect(await page.locator('[data-harbor]').count()).toBe(0)
        const tabs = (await page.locator('.browser-tabs button').allTextContents()).map((label) => label.trim()).filter(Boolean)
        expect(tabs, viewport.name).toEqual(['My Library', 'Patterns', 'Clips'])
      }
      expect(problems.filter((line) => /WorkletGlobalScope|unhandled|Uncaught/i.test(line))).toEqual([])
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 240000)

  it('matches a direct sine to the safety chain in an OfflineAudioContext', async () => {
    const curve = Array.from(safetyCurve())
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const result = await page.evaluate(async (points) => {
        const rate = 48000
        const length = rate
        async function render(chain: boolean) {
          const ctx = new OfflineAudioContext(2, length, rate)
          try {
            ctx.destination.channelCount = 2
            ctx.destination.channelCountMode = 'explicit'
            ctx.destination.channelInterpretation = 'speakers'
          } catch { /* some builds lock the destination */ }
          const osc = ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.value = (80 * rate) / 8192
          const gain = ctx.createGain()
          gain.gain.value = 0.25
          osc.connect(gain)
          if (chain) {
            const shaper = ctx.createWaveShaper()
            shaper.curve = new Float32Array(points)
            shaper.oversample = 'none'
            gain.connect(shaper)
            shaper.connect(ctx.destination)
          } else gain.connect(ctx.destination)
          osc.start(0)
          const audio = await ctx.startRendering()
          const left = audio.getChannelData(0)
          const n = 8192
          const start = Math.floor(length * 0.4)
          const power = (bin: number) => {
            let re = 0
            let im = 0
            for (let i = 0; i < n; i++) {
              const w = (2 * Math.PI * bin * i) / n
              const sample = left[start + i]
              re += sample * Math.cos(w)
              im -= sample * Math.sin(w)
            }
            return re * re + im * im
          }
          const bin = 80
          const base = power(bin)
          let harm = 0
          for (let h = 2; h <= 6; h++) harm += power(bin * h)
          let peak = 0
          let zeros = 0
          let run = 0
          for (let i = start; i < start + n; i++) {
            peak = Math.max(peak, Math.abs(left[i]))
            if (left[i] === 0) {
              run += 1
              zeros = Math.max(zeros, run)
            } else run = 0
          }
          return { peak, thd: base > 0 ? Math.sqrt(harm / base) : 1, zeros }
        }
        const direct = await render(false)
        const through = await render(true)
        const pan = async (value: number) => {
          const ctx = new OfflineAudioContext(2, 4800, rate)
          const osc = ctx.createOscillator()
          osc.frequency.value = 440
          const splitter = ctx.createGain()
          const left = ctx.createGain()
          const right = ctx.createGain()
          const merger = ctx.createChannelMerger(2)
          const angle = ((value + 1) * Math.PI) / 4
          left.gain.value = Math.cos(angle)
          right.gain.value = Math.sin(angle)
          osc.connect(splitter)
          splitter.connect(left)
          splitter.connect(right)
          left.connect(merger, 0, 0)
          right.connect(merger, 0, 1)
          merger.connect(ctx.destination)
          osc.start(0)
          const audio = await ctx.startRendering()
          const peak = (channel: Float32Array) => {
            let best = 0
            for (let i = 1000; i < channel.length; i++) best = Math.max(best, Math.abs(channel[i]))
            return best
          }
          return { left: peak(audio.getChannelData(0)), right: peak(audio.getChannelData(1)) }
        }
        return { direct, through, hardLeft: await pan(-1), center: await pan(0), hardRight: await pan(1) }
      }, curve)
      const directDb = 20 * Math.log10(result.direct.peak)
      const throughDb = 20 * Math.log10(result.through.peak)
      expect(Math.abs(throughDb - directDb)).toBeLessThan(0.5)
      expect(result.through.thd).toBeLessThan(0.001)
      expect(result.through.zeros).toBeLessThan(4)
      expect(result.direct.zeros).toBeLessThan(4)
      const db = (value: number) => 20 * Math.log10(Math.max(1e-8, value))
      expect(db(result.hardLeft.right) - db(result.hardLeft.left)).toBeLessThan(-40)
      expect(db(result.hardRight.left) - db(result.hardRight.right)).toBeLessThan(-40)
      expect(Math.abs(db(result.center.left) - db(result.center.right))).toBeLessThan(0.5)
      expect(Math.abs(db(result.center.left) - db(0.7071))).toBeLessThan(0.5)
    } finally {
      await browser.close()
    }
  }, 60000)
})
