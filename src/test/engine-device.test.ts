import { availableParallelism } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readStoredBufferHint } from '../audio/core/buffer'
import {
  bufferSamplesFor,
  chooseBufferHint,
  deviceKind,
  initialBufferHint,
  monitoringSamples,
  outputLatencySamples,
  recordingAlignmentSamples,
  resumeNeedsGesture,
  routeChangePlan,
  routeOf,
} from '../audio/core/driver'
import { adoptRealtime, canOffloadChain, isolationAvailable } from '../audio/core/isolate'
import { interruptionNotice, planInterruption, planRecovery } from '../audio/core/session'
import { measureRealtime } from '../audio/realtimeMeasure'
import { startNodeRealtime } from '../audio/nodeRealtime'
import { isolationHeaders } from '../../server/headers'

describe('device driver', () => {
  it('picks a longer buffer for iOS and for Bluetooth', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'
    const pixel = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'
    expect(deviceKind(iphone)).toBe('ios-safari')
    expect(deviceKind(pixel)).toBe('android-chrome')
    expect(chooseBufferHint('ios-safari', 'speaker')).toBe('balanced')
    expect(chooseBufferHint('ios-safari', 'bluetooth')).toBe('playback')
    expect(chooseBufferHint('android-chrome', 'wired')).toBe('interactive')
    expect(chooseBufferHint('android-chrome', 'bluetooth')).toBe('balanced')
    expect(bufferSamplesFor('interactive')).toBe(128)
    expect(bufferSamplesFor('balanced')).toBe(256)
    expect(bufferSamplesFor('playback')).toBe(1024)
    expect(initialBufferHint(null, iphone)).toBe('balanced')
    expect(initialBufferHint({ getItem: () => 'playback' }, iphone)).toBe('playback')
    expect(readStoredBufferHint({ getItem: () => null })).toBeNull()
  })

  it('rebuilds when the sample rate or the route changes, and resumes for a latency jump', () => {
    expect(routeOf('AirPods Pro')).toBe('bluetooth')
    expect(routeOf('USB Scarlett 2i2')).toBe('wired')
    expect(routeOf('')).toBe('unknown')
    const wired = { sampleRate: 48000, route: 'wired' as const, outputLatency: 0.008 }
    expect(routeChangePlan(wired, { ...wired, sampleRate: 44100 })).toBe('rebuild')
    expect(routeChangePlan(wired, { ...wired, route: 'bluetooth', outputLatency: 0.08 })).toBe('rebuild')
    expect(routeChangePlan(wired, { ...wired, outputLatency: 0.04 })).toBe('resume')
    expect(routeChangePlan(wired, { ...wired })).toBe('none')
    expect(routeChangePlan(null, wired)).toBe('none')
    expect(resumeNeedsGesture('ios-safari', 'suspended', false)).toBe(true)
    expect(resumeNeedsGesture('ios-safari', 'suspended', true)).toBe(false)
    expect(resumeNeedsGesture('android-chrome', 'suspended', false)).toBe(false)
  })

  it('shifts the recording by the output latency and keeps that out of a second speaker delay', () => {
    const samples = outputLatencySamples(0.01, 48000)
    expect(samples).toBe(480)
    expect(recordingAlignmentSamples(0.003, 0.01, 48000)).toBe(Math.round(0.013 * 48000))
    expect(monitoringSamples(64, 0.01, 48000)).toBe(64 + 480)
  })
})

describe('interruption recovery', () => {
  it('keeps the playhead and finalizes a take for a call, a lock, and a hidden tab', () => {
    const call = planInterruption({ state: 'interrupted', visible: true, ios: true, recording: true })
    expect(call.kind).toBe('call')
    expect(call.keepPlayhead).toBe(true)
    expect(call.finalizeTake).toBe(true)
    expect(call.action).toBe('resume')
    expect(call.notice).toContain('call or Siri')
    expect(call.notice).toContain('take was kept')
    expect(interruptionNotice('siri', true)).toContain('playhead')

    const other = planInterruption({ state: 'interrupted', visible: true, ios: false, recording: true })
    expect(other.kind).toBe('other-app')
    expect(other.notice).toContain('Another app')

    const lock = planInterruption({ state: 'suspended', visible: false, hiddenKind: 'lock', recording: true })
    expect(lock.kind).toBe('screen-lock')
    expect(lock.pause).toBe(true)
    expect(lock.action).toBe('none')
    expect(lock.finalizeTake).toBe(true)
    expect(lock.notice).toContain('screen is locked')

    const tab = planInterruption({ state: 'running', visible: false, hiddenKind: 'tab', recording: false })
    expect(tab.kind).toBe('background')
    expect(tab.pause).toBe(true)
    expect(tab.finalizeTake).toBe(false)
    expect(tab.notice).toContain('background')
    expect(planInterruption({ state: 'running', visible: true }).notice).toBe('')
    expect(planRecovery('interrupted', false)).toBe('none')
  })
})

describe('cross-origin isolation', () => {
  it('uses credentialless COEP so fonts and fetches without CORP still load', () => {
    expect(isolationHeaders()).toEqual({
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
    })
    expect(isolationHeaders()['cross-origin-embedder-policy']).not.toBe('require-corp')
    expect(canOffloadChain([{ pluginId: 'eq', sidechain: '' }])).toBe(true)
    expect(canOffloadChain([{ pluginId: 'sampler', sidechain: '' }])).toBe(false)
    expect(canOffloadChain([{ pluginId: 'compressor', sidechain: 'kick', enabled: true }])).toBe(false)
    expect(adoptRealtime(8, 3, 0, 2.6)).toBe(false)
    expect(adoptRealtime(8, 2, 0, 2.6)).toBe(true)
    expect(adoptRealtime(8, 2, 1, 2.6)).toBe(false)
    expect(isolationAvailable()).toBe(false)
  })
})

describe('realtime graph', () => {
  it('renders a quantum on shared memory and reports the audio-thread headroom', async () => {
    const flag = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
    const previous = flag.__CUEHARBOR_WASM_DSP__
    flag.__CUEHARBOR_WASM_DSP__ = false
    const pool = startNodeRealtime(Math.min(4, availableParallelism()), 8)
    try {
      const report = await measureRealtime(pool, { tracks: 8, frames: 128, rounds: 5 })
      mkdirSync('/opt/cursor/artifacts', { recursive: true })
      writeFileSync('/opt/cursor/artifacts/realtime-benchmark.json', JSON.stringify(report, null, 2))
      expect(report.misses).toBe(0)
      expect(report.maxError).toBeLessThan(1e-4)
      expect(report.publishMs).toBeLessThan(report.sequentialMs)
      expect(report.parallelMs).toBeGreaterThan(0)
    } finally {
      await pool.close()
      if (previous === undefined) delete flag.__CUEHARBOR_WASM_DSP__
      else flag.__CUEHARBOR_WASM_DSP__ = previous
    }
  }, 60_000)
})
