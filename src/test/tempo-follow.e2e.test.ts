import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

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

async function readClip(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __cueharbor: {
        store: {
          project: {
            tempo: number
            sampleRate: number
            tracks: { id: string; type: string; clips: { id: string; name: string; durationSamples: number; bufferId: string; stretch?: { followTempo?: boolean; sourceBpm?: number | null; sourceSamples?: number } }[] }[]
          }
          buffers: Map<string, { channels: Float32Array[] }>
        }
      }
    }).__cueharbor.store
    const host = store.project.tracks.find((track) => track.clips.some((clip) => clip.name.includes('2-AND-4 (100)')))
    const clip = host?.clips.find((item) => item.name.includes('2-AND-4 (100)'))
    const channel = clip ? store.buffers.get(clip.bufferId)?.channels[0] : undefined
    const node = clip ? document.querySelector(`[data-clip="${clip.id}"]`) as HTMLElement | null : null
    const box = node?.getBoundingClientRect()
    return {
      tempo: store.project.tempo,
      rate: store.project.sampleRate,
      follow: !!clip?.stretch?.followTempo,
      bpm: clip?.stretch?.sourceBpm ?? 0,
      duration: clip?.durationSamples ?? 0,
      source: channel?.length ?? 0,
      beats: clip ? (clip.durationSamples / store.project.sampleRate) * (store.project.tempo / 60) : 0,
      width: box?.width ?? 0,
      text: node?.innerText ?? '',
    }
  })
}

describe('production loop tempo follow', () => {
  it('stretches a loaded SoundScout loop when the song tempo changes', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4600 + Math.floor(Math.random() * 200)
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    try {
      await waitForServer(url, child)
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().click()
      await page.locator('.arrange [data-track-name="Vocal"]').waitFor()
      await page.waitForFunction(() => {
        const hook = (window as unknown as { __cueharbor?: { store: { project: { id: string; tracks: unknown[] } } }; __projectSeen?: { id: string; at: number } }).__cueharbor
        const store = hook?.store
        if (!store?.project.tracks.length) return false
        const seen = (window as unknown as { __projectSeen?: { id: string; at: number } }).__projectSeen
        const id = `${store.project.id}:${store.project.tracks.length}`
        if (!seen || seen.id !== id) {
          ;(window as unknown as { __projectSeen?: { id: string; at: number } }).__projectSeen = { id, at: performance.now() }
          return false
        }
        return performance.now() - seen.at > 400
      })
      await page.evaluate(() => {
        const hook = (window as unknown as { __cueharbor: { engine: { seek: (sample: number) => void }; store: { setTempo: (bpm: number) => void } } }).__cueharbor
        hook.engine.seek(0)
        hook.store.setTempo(120)
      })
      await page.evaluate(() => {
        const hook = (window as unknown as {
          __cueharbor: {
            store: {
              project: { sampleRate: number; tempo: number; tracks: { id: string; type: string }[] }
              addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
              addAudioClip: (trackId: string, clip: Record<string, unknown>) => void
            }
          }
        }).__cueharbor
        const store = hook.store
        const rate = store.project.sampleRate
        const sourceBpm = 100
        const beats = 8
        const sourceSamples = Math.round(rate * beats * 60 / sourceBpm)
        const channel = new Float32Array(sourceSamples)
        for (let i = 0; i < channel.length; i++) channel[i] = Math.sin((2 * Math.PI * 110 * i) / rate) * 0.35
        store.addAsset({ id: 'loopbuf', name: '2-AND-4 (100)', sampleRate: rate, channels: [channel] })
        const track = store.project.tracks.find((item) => item.type === 'audio')
        if (!track) throw new Error('no audio track')
        store.addAudioClip(track.id, {
          id: 'loopclip',
          name: '2-AND-4 (100)',
          bufferId: 'loopbuf',
          startSample: 0,
          offsetSamples: 0,
          durationSamples: Math.round(sourceSamples * sourceBpm / store.project.tempo),
          fadeInSamples: 0,
          fadeOutSamples: 0,
          gain: 1,
          source: 'import',
          stretch: { sourceSamples, semitones: 0, cents: 0, mode: 'pro', followTempo: true, sourceBpm, markers: [] },
        })
      })
      const clip = page.locator('[data-clip="loopclip"]')
      try {
        await clip.waitFor({ timeout: 20000 })
      } catch (error) {
        const detail = await page.evaluate(() => {
          const store = (window as unknown as { __cueharbor?: { store: { project: { tracks: { name: string; type: string; clips: { id: string }[] }[] } } } }).__cueharbor?.store
          const node = document.querySelector('[data-clip="loopclip"]') as HTMLElement | null
          const box = node?.getBoundingClientRect()
          return {
            tracks: store?.project.tracks.map((track) => `${track.name}:${track.type}:${track.clips.map((item) => item.id).join(',')}`) ?? [],
            box: box ? { w: box.width, h: box.height } : null,
          }
        })
        throw new Error(`${error instanceof Error ? error.message : 'clip missing'} ${JSON.stringify(detail)}`)
      }
      const loaded = await readClip(page)
      expect(loaded.follow).toBe(true)
      expect(loaded.bpm).toBe(100)
      expect(loaded.source).toBeGreaterThan(1000)
      expect(loaded.beats).toBeGreaterThan(7.5)
      expect(loaded.beats).toBeLessThan(8.5)
      expect(loaded.text).not.toMatch(/Zoom/)

      const tempo = page.getByRole('button', { name: /Tap to set tempo/ })
      await tempo.click()
      const field = page.getByRole('spinbutton', { name: /exact tempo/i })
      await field.waitFor({ timeout: 4000 })
      await field.fill('90')
      await field.press('Enter')
      await page.waitForTimeout(100)
      const at90 = await readClip(page)
      expect(at90.tempo).toBe(90)
      expect(at90.follow).toBe(true)
      expect(at90.beats).toBeGreaterThan(7.5)
      expect(at90.beats).toBeLessThan(8.5)
      expect(at90.duration).toBeGreaterThan(loaded.duration)
      await page.screenshot({ path: '/opt/cursor/artifacts/loop-tempo-90.png' })

      await page.evaluate(() => (window as unknown as { __cueharbor: { store: { setTempo: (bpm: number) => void } } }).__cueharbor.store.setTempo(140))
      const at140 = await readClip(page)
      expect(at140.tempo).toBe(140)
      expect(at140.beats).toBeGreaterThan(7.5)
      expect(at140.beats).toBeLessThan(8.5)
      expect(at140.duration).toBeLessThan(at90.duration)
      expect(at140.width).toBeLessThan(at90.width)
      await page.screenshot({ path: '/opt/cursor/artifacts/loop-tempo-140.png' })

      await page.evaluate(() => (window as unknown as { __cueharbor: { store: { setTempo: (bpm: number) => void } } }).__cueharbor.store.setTempo(120))
      const back = await readClip(page)
      expect(back.tempo).toBe(120)
      expect(Math.abs(back.duration - loaded.duration)).toBeLessThan(8)
      expect(back.source).toBe(loaded.source)

      const live = await page.evaluate(async () => {
        const Orig = AudioBufferSourceNode.prototype.start
        let starts = 0
        AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<AudioBufferSourceNode['start']>) {
          starts += 1
          return Orig.apply(this, args)
        }
        const hook = (window as unknown as {
          __cueharbor: {
            engine: { resume: () => Promise<void>; seek: (sample: number) => void; play: (sample: number) => Promise<void>; stop: () => void; levels: () => { master: number } }
            store: { setTempo: (bpm: number) => void; project: { tempo: number } }
          }
        }).__cueharbor
        await hook.engine.resume()
        hook.engine.seek(0)
        const before = starts
        await hook.engine.play(0)
        let heard = 0
        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          heard = Math.max(heard, hook.engine.levels().master || 0)
        }
        const playing = starts
        hook.store.setTempo(90)
        hook.store.setTempo(140)
        hook.store.setTempo(120)
        await new Promise((resolve) => setTimeout(resolve, 250))
        const after = starts
        hook.engine.stop()
        AudioBufferSourceNode.prototype.start = Orig
        return { heard, before, playing, after, tempo: hook.store.project.tempo }
      })
      expect(live.heard).toBeGreaterThan(0.02)
      expect(live.playing).toBeGreaterThan(live.before)
      expect(live.after).toBeGreaterThan(live.playing)
      expect(live.tempo).toBe(120)

      const audio = await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor: {
            engine: { exportMix: (project: unknown, assets: Map<string, unknown>) => Promise<ArrayBuffer> }
            store: {
              project: { tempo: number; sampleRate: number; tracks: { id: string; clips: { id: string; name: string; durationSamples: number }[] }[] }
              buffers: Map<string, { sampleRate: number; channels: Float32Array[] }>
              setTempo: (bpm: number) => void
              addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
              addAudioClip: (trackId: string, clip: Record<string, unknown>) => void
              deleteSelectedClip: () => void
              selectClip: (trackId: string, clipId: string) => void
            }
          }
        }).__cueharbor
        const rate = hook.store.project.sampleRate
        const mixOf = async () => {
          const wav = await hook.engine.exportMix(hook.store.project, hook.store.buffers)
          const ctx = new AudioContext()
          const audio = await ctx.decodeAudioData(wav.slice(0))
          const data = audio.getChannelData(0)
          await ctx.close()
          let last = 0
          for (let i = 0; i < data.length; i += 32) if (Math.abs(data[i] || 0) > 0.02) last = i
          return { seconds: last / audio.sampleRate }
        }
        hook.store.setTempo(140)
        const drum = await mixOf()
        const host = hook.store.project.tracks.find((track) => track.clips.some((clip) => clip.name.includes('2-AND-4 (100)')))
        const boom = host?.clips.find((clip) => clip.name.includes('2-AND-4 (100)'))
        if (host && boom) hook.store.selectClip(host.id, boom.id)
        hook.store.deleteSelectedClip()
        const tone = new Float32Array(Math.round(0.8 * rate))
        for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4
        hook.store.addAsset({ id: 'sinebuf', name: 'Sine', sampleRate: rate, channels: [tone] })
        const audioTrack = hook.store.project.tracks.find((track) => track.id === host?.id) ?? hook.store.project.tracks.find((track) => track.clips.length >= 0)
        hook.store.addAudioClip(audioTrack!.id, {
          id: 'sine',
          name: 'Sine',
          bufferId: 'sinebuf',
          startSample: 0,
          offsetSamples: 0,
          durationSamples: tone.length,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          gain: 1,
          source: 'import',
          stretch: { sourceSamples: tone.length, semitones: 0, cents: 0, mode: 'pro', followTempo: true, sourceBpm: 100, markers: [] },
        })
        hook.store.setTempo(90)
        const wav = await hook.engine.exportMix(hook.store.project, hook.store.buffers)
        const ctx = new AudioContext()
        const decoded = await ctx.decodeAudioData(wav.slice(0))
        const channel = decoded.getChannelData(0)
        await ctx.close()
        let last = 0
        let peak = 0
        for (let i = 0; i < channel.length; i += 32) {
          const mag = Math.abs(channel[i] || 0)
          if (mag > 0.02) last = i
          if (i < decoded.sampleRate && mag > peak) peak = mag
        }
        const start = Math.round(decoded.sampleRate * 0.15)
        const frame = channel.subarray(start, start + 4096)
        let corrBest = 0
        let at = 0
        const minLag = Math.round(decoded.sampleRate / 800)
        const maxLag = Math.round(decoded.sampleRate / 200)
        for (let lag = minLag; lag <= maxLag; lag++) {
          let corr = 0
          for (let i = 0; i < frame.length - lag; i += 2) corr += (frame[i] || 0) * (frame[i + lag] || 0)
          if (corr > corrBest) {
            corrBest = corr
            at = lag
          }
        }
        const hz = at ? decoded.sampleRate / at : 0
        const sine = hook.store.project.tracks.flatMap((track) => track.clips).find((clip) => clip.name === 'Sine')
        return {
          drumSeconds: drum.seconds,
          sineSeconds: last / decoded.sampleRate,
          hz,
          peak,
          sineBeats: sine ? (sine.durationSamples / hook.store.project.sampleRate) * (hook.store.project.tempo / 60) : 0,
          sineDuration: sine?.durationSamples ?? 0,
          tempo: hook.store.project.tempo,
        }
      })
      expect(audio.drumSeconds).toBeGreaterThan(3.05)
      expect(audio.drumSeconds).toBeLessThan(3.85)
      expect(Math.abs(1200 * Math.log2(audio.hz / 440))).toBeLessThan(40)
      expect(audio.sineSeconds).toBeGreaterThan(0.8)
      expect(audio.sineSeconds).toBeLessThan(1.05)
      expect(audio.sineBeats).toBeGreaterThan(1.2)
      expect(audio.sineBeats).toBeLessThan(1.5)

      const kept = await page.evaluate(async () => {
        const store = (window as unknown as {
          __cueharbor: { store: { hasUnsavedEdits: () => boolean; project: { tempo: number; tracks: { clips: { name: string; durationSamples: number; stretch?: { followTempo?: boolean; sourceBpm?: number | null } }[] }[] } } }
        }).__cueharbor.store
        const sine = store.project.tracks.flatMap((track) => track.clips).find((clip) => clip.name === 'Sine')
        window.dispatchEvent(new Event('pagehide'))
        const started = performance.now()
        while (store.hasUnsavedEdits() && performance.now() - started < 8000) await new Promise((resolve) => setTimeout(resolve, 50))
        return {
          saved: !store.hasUnsavedEdits(),
          tempo: store.project.tempo,
          follow: !!sine?.stretch?.followTempo,
          bpm: sine?.stretch?.sourceBpm ?? 0,
          duration: sine?.durationSamples ?? 0,
        }
      })
      expect(kept.saved).toBe(true)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.waitForFunction(() => {
        const store = (window as unknown as { __cueharbor?: { store: { project: { tracks: { clips: { name: string }[] }[] } } } }).__cueharbor?.store
        return !!store?.project.tracks.some((track) => track.clips.some((clip) => clip.name === 'Sine'))
      })
      const reopened = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor?: { store: { project: { tempo: number; sampleRate: number; tracks: { clips: { name: string; durationSamples: number; stretch?: { followTempo?: boolean; sourceBpm?: number | null } }[] }[] }; setTempo: (bpm: number) => void } }
        }).__cueharbor?.store
        const sine = store?.project.tracks.flatMap((track) => track.clips).find((clip) => clip.name === 'Sine')
        if (!store || !sine) return null
        const before = sine.durationSamples
        store.setTempo(140)
        const beats = (sine.durationSamples / store.project.sampleRate) * (store.project.tempo / 60)
        return { tempo: store.project.tempo, follow: !!sine.stretch?.followTempo, bpm: sine.stretch?.sourceBpm ?? 0, before, duration: sine.durationSamples, beats }
      })
      expect(reopened?.follow).toBe(true)
      expect(reopened?.bpm).toBe(100)
      expect(reopened?.before).toBe(kept.duration)
      expect(reopened?.tempo).toBe(140)
      expect(reopened?.duration).toBeLessThan(reopened!.before)
      expect(reopened?.beats ?? 0).toBeGreaterThan(1.2)
      expect(reopened?.beats ?? 0).toBeLessThan(1.5)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: '/opt/cursor/artifacts/loop-tempo-140-phone.png' })
    } finally {
      await browser.close()
      child.kill()
    }
  }, 180000)
})
