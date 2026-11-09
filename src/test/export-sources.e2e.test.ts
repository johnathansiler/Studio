import { spawn, type ChildProcess } from 'node:child_process'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { beatSpanSamples } from '../model/tempoMap'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(detail || 'preview exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'preview did not start')
}

describe('export in the built app', () => {
  it('prints a loaded step sample on the tempo map', async () => {
    const port = 4700 + Math.floor(Math.random() * 200)
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, child)
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      const heard = await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor: {
            engine: { exportMix: (project: unknown, assets: Map<string, unknown>) => Promise<ArrayBuffer> }
            store: {
              project: { sampleRate: number; tempo: number; tempoMap?: { beat: number; bpm: number }[]; tracks: { id: string; type: string; plugins: { pluginId: string; steps?: { patterns: { channels: { kind: string; note: number; mute: boolean; sampleId: string | null; cells: { on: boolean }[] }[] }[] } }[] }[] }
              addPlugin: (trackId: string, pluginId: string) => void
              addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
              buffers: Map<string, unknown>
            }
          }
        }).__cueharbor
        const track = hook.store.project.tracks.find((item) => item.type === 'midi')
        if (!track) throw new Error('missing midi track')
        hook.store.project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
        hook.store.addPlugin(track.id, 'steps')
        const plugin = track.plugins.find((item) => item.pluginId === 'steps')
        const pattern = plugin?.steps?.patterns[0]
        if (!pattern) throw new Error('missing steps')
        const rate = hook.store.project.sampleRate
        const tick = new Float32Array(Math.round(rate * 0.05))
        tick.fill(0.8)
        hook.store.addAsset({ id: 'tick', name: 'tick', sampleRate: rate, channels: [tick, tick.slice()] })
        for (const channel of pattern.channels) {
          channel.mute = channel.kind !== 'kick'
          channel.sampleId = channel.kind === 'kick' ? 'tick' : null
          if (channel.kind === 'kick') channel.note = 60
          for (const cell of channel.cells) cell.on = false
        }
        const kick = pattern.channels.find((channel) => channel.kind === 'kick')
        if (!kick) throw new Error('missing kick')
        kick.cells[8].on = true
        const wav = await hook.engine.exportMix(hook.store.project, hook.store.buffers)
        const ctx = new AudioContext()
        const audio = await ctx.decodeAudioData(wav.slice(0))
        const data = audio.getChannelData(0)
        await ctx.close()
        let best = 0
        let at = 0
        let first = -1
        for (let i = 0; i < data.length; i++) {
          const mag = Math.abs(data[i] || 0)
          if (mag > best) {
            best = mag
            at = i
          }
          if (first < 0 && mag > 0.05) first = i
        }
        return { rate: audio.sampleRate, at, best, first }
      })
      const mapped = Math.round(beatSpanSamples({
        tempo: 120,
        sampleRate: heard.rate,
        tempoMap: [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }],
        automation: [],
      }, 2, 0.25).start)
      const linear = Math.round(2 * heard.rate * 60 / 120)
      expect(heard.best).toBeGreaterThan(0.05)
      expect(heard.first).toBeGreaterThan(0)
      expect(Math.abs(heard.first - mapped)).toBeLessThan(heard.rate * 0.03)
      expect(Math.abs(mapped - linear)).toBeGreaterThan(heard.rate * 0.2)
      expect(Math.abs(heard.first - linear)).toBeGreaterThan(heard.rate * 0.1)
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  })
})
