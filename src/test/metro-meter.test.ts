import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it } from 'vitest'
import { clickDuration, clickVoice } from '../audio/metroClick'
import { meterFftSize, releasePeak } from '../audio/strips'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function launch() {
  try {
    return await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] })
  } catch {
    return chromium.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    })
  }
}

describe('metronome click level', () => {
  it('keeps the original short tick instead of holding the peak', () => {
    const accent = clickVoice(true, false)
    const beat = clickVoice(false, false)
    expect(accent.peak).toBe(0.35)
    expect(beat.peak).toBe(0.18)
    expect(accent.hold).toBe(0)
    expect(accent.attack).toBeCloseTo(0.002)
    expect(clickDuration(accent)).toBeCloseTo(0.045)
    expect(clickDuration(accent)).toBeLessThanOrEqual(0.05)
    const at = (voice: typeof accent, t: number) => {
      if (t <= 0 || t >= clickDuration(voice)) return 0.0001
      if (t < voice.attack) return 0.0001 * (voice.peak / 0.0001) ** (t / voice.attack)
      const fall = t - voice.attack - voice.hold
      if (fall <= 0) return voice.peak
      return voice.peak * (0.0001 / voice.peak) ** (fall / voice.decay)
    }
    expect(at(accent, 0.002)).toBeCloseTo(accent.peak, 5)
    expect(at(accent, 0.02)).toBeLessThan(accent.peak * 0.08)
  })

  it('reads a short peak from a frame-sized window and drops before a mute check', () => {
    for (const rate of [44100, 48000, 96000]) {
      const size = meterFftSize(rate)
      const span = size / rate
      expect(span).toBeGreaterThan(1 / 70)
      expect(span).toBeLessThan(0.032)
      const window = new Float32Array(size)
      const burst = Math.round(0.004 * rate)
      for (let i = 0; i < burst; i++) window[i] = (i % 2 ? 1 : -1) * 0.14
      let peak = 0
      let tail = 0
      for (let i = 0; i < window.length; i++) peak = Math.max(peak, Math.abs(window[i]))
      for (let i = window.length - 256; i < window.length; i++) tail += window[i] * window[i]
      expect(peak).toBeGreaterThan(0.05)
      expect(Math.sqrt(tail / 256)).toBeLessThan(0.001)
      const held = releasePeak(peak, 0, 0.06 - span)
      expect(held).toBeLessThan(0.01)
      expect(releasePeak(peak, 0, 0.04 - span)).toBeLessThan(peak * 0.25)
    }
  })

  it('shows on the master meter after a sample-rate retarget and a graph rebuild', async () => {
    const port = 5199
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, web)
      browser = await launch()
      const page = await browser.newPage()
      const accent = clickVoice(true, false)
      const offline = await page.evaluate(async (voice) => {
        async function render(rate: number) {
          const length = Math.round(rate * 0.25)
          const ctx = new OfflineAudioContext(2, length, rate)
          const metro = ctx.createGain()
          metro.gain.value = 0.45
          const master = ctx.createGain()
          master.gain.value = 0.9
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = voice.type as OscillatorType
          const at = 0.02
          const floor = 0.0001
          const peak = Math.max(floor * 2, voice.peak)
          const attackAt = at + voice.attack
          const holdAt = attackAt + voice.hold
          const endAt = holdAt + voice.decay
          osc.frequency.setValueAtTime(voice.frequency, at)
          gain.gain.setValueAtTime(floor, at)
          gain.gain.exponentialRampToValueAtTime(peak, attackAt)
          if (voice.hold > 0) gain.gain.linearRampToValueAtTime(peak, holdAt)
          gain.gain.exponentialRampToValueAtTime(floor, endAt)
          osc.connect(gain)
          gain.connect(metro)
          metro.connect(master)
          master.connect(ctx.destination)
          osc.start(at)
          osc.stop(endAt + 0.005)
          const audio = await ctx.startRendering()
          const left = audio.getChannelData(0)
          let samplePeak = 0
          let lead = 0
          let tail = 0
          const leadEnd = Math.round(rate * 0.01)
          const tailFrom = Math.round(rate * 0.08)
          for (let i = 0; i < left.length; i++) {
            const value = Math.abs(left[i])
            samplePeak = Math.max(samplePeak, value)
            if (i < leadEnd) lead = Math.max(lead, value)
            if (i >= tailFrom) tail = Math.max(tail, value)
          }
          return { samplePeak, lead, tail }
        }
        return { at48: await render(48000), at44: await render(44100) }
      }, accent)
      expect(offline.at48.samplePeak).toBeGreaterThan(0.11)
      expect(offline.at48.lead).toBeLessThan(0.002)
      expect(offline.at48.tail).toBeLessThan(0.002)
      expect(offline.at44.samplePeak).toBeGreaterThan(0.11)
      expect(offline.at44.lead).toBeLessThan(0.002)
      expect(offline.at44.tail).toBeLessThan(0.002)

      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean((window as unknown as { __cueharbor?: { engine?: unknown } }).__cueharbor?.engine), null, { timeout: 20000 })
      const live = await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor: {
            engine: {
              resume: () => Promise<void>
              sync: (project: unknown, assetOf: (id: string) => unknown) => void
              playAtPerf: (sample: number, perf: number, mode: string) => Promise<void>
              stop: () => void
              levels: () => { master: number }
              sampleRate: number
              setLatencyChoice: (hint: string) => Promise<unknown>
              latencyChoice: string
              ctx: AudioContext
            }
            store: {
              project: {
                sampleRate: number
                countIn: boolean
                countInBars?: number
                metronomeEnabled: boolean
                masterVolume: number
                loopEnabled: boolean
                tempo: number
                tracks: { clips: unknown[]; midiClips: unknown[] }[]
                patternClips?: unknown[]
              }
              buffers: Map<string, unknown>
              retargetSampleRate: (rate: number) => void
            }
          }
        }).__cueharbor
        const { engine, store } = hook
        await engine.resume()
        const native = engine.sampleRate
        const project = store.project
        project.countIn = false
        project.countInBars = 0
        project.metronomeEnabled = true
        project.masterVolume = 0.9
        project.loopEnabled = false
        project.tempo = 120
        for (const track of project.tracks) {
          track.clips = []
          track.midiClips = []
        }
        project.patternClips = []
        project.sampleRate = native === 48000 ? 44100 : 48000
        store.retargetSampleRate(native)
        engine.sync(store.project, (id) => store.buffers.get(id))
        const starts: number[] = []
        const orig = AudioContext.prototype.createOscillator
        AudioContext.prototype.createOscillator = function () {
          const osc = orig.call(this)
          const start = osc.start.bind(osc)
          osc.start = (when?: number) => {
            if (osc.type === 'square' && typeof when === 'number') starts.push(when)
            return typeof when === 'number' ? start(when) : start()
          }
          return osc
        }
        async function listen() {
          starts.length = 0
          await engine.playAtPerf(0, performance.now() + 80, 'arrangement')
          let peak = 0
          const began = performance.now()
          while (performance.now() - began < 2200) {
            peak = Math.max(peak, engine.levels().master || 0)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          engine.stop()
          const squares = starts.slice()
          const gaps: number[] = []
          for (let i = 1; i < squares.length; i++) gaps.push(squares[i] - squares[i - 1])
          return { peak, gaps, projectRate: project.sampleRate, ctxRate: engine.ctx.sampleRate }
        }
        const retargeted = await listen()
        await engine.setLatencyChoice(engine.latencyChoice)
        project.countIn = false
        project.metronomeEnabled = true
        engine.sync(project, (id) => store.buffers.get(id))
        const rebuilt = await listen()
        AudioContext.prototype.createOscillator = orig
        return { native, retargeted, rebuilt }
      })
      expect(live.retargeted.projectRate).toBe(live.native)
      expect(live.retargeted.ctxRate).toBe(live.native)
      expect(live.retargeted.peak).toBeGreaterThan(0.05)
      expect(live.retargeted.gaps.length).toBeGreaterThanOrEqual(3)
      for (const gap of live.retargeted.gaps) expect(gap).toBeCloseTo(0.5, 2)
      expect(live.rebuilt.peak).toBeGreaterThan(0.05)
      expect(live.rebuilt.gaps.length).toBeGreaterThanOrEqual(3)
      for (const gap of live.rebuilt.gaps) expect(gap).toBeCloseTo(0.5, 2)
    } finally {
      await browser?.close()
      web.kill('SIGTERM')
    }
  }, 180000)
})
