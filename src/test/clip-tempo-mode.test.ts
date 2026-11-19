import { mkdirSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderClipChannels, timelineSamples } from '../audio/stretch/engine'
import { followClockToken } from '../audio/stretch/commit'
import { encodeWav } from '../model/wav'
import {
  clampLockBpm,
  clipTempoMode,
  clipTempoPatch,
  effectiveClipBpm,
  lockedTimelineSamples,
  projectBeatSpan,
  tempoModeFactor,
} from '../model/clipTempo'
import { migrateProject } from '../model/schema'
import { createEmptyProject, type AudioClip, type ClipStretch } from '../model/types'
import { ProjectStore } from '../state/store'
import { ClipSheet } from '../ui/ClipSheet'
import { PhoneDock } from '../ui/phoneDock'

const rate = 48000

function sine(seconds: number, hz: number) {
  const data = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5
  return data
}

function stretchOf(sourceSamples: number, sourceBpm: number, follow = true): ClipStretch {
  return {
    sourceSamples,
    semitones: 0,
    cents: 0,
    mode: 'pro',
    followTempo: follow,
    sourceBpm,
    markers: [],
  }
}

function beatsOf(samples: number, tempo: number) {
  return (samples / rate) * (tempo / 60)
}

function mount(sourceBpm: number, bars: number, projectBpm: number, channel?: Float32Array) {
  const project = createEmptyProject(rate)
  project.tempo = projectBpm
  const sourceSamples = Math.round(bars * 4 * rate * 60 / sourceBpm)
  const audio = channel && channel.length === sourceSamples ? channel : sine(sourceSamples / rate, 220)
  const store = new ProjectStore(project)
  const track = store.project.tracks.find((item) => item.type === 'audio')!
  const clip: AudioClip = {
    id: 'loop',
    name: 'Loop',
    bufferId: 'buf',
    startSample: 0,
    offsetSamples: 0,
    durationSamples: sourceSamples,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'import',
    stretch: stretchOf(audio.length, sourceBpm, true),
  }
  store.addAsset({ id: 'buf', name: 'Loop', sampleRate: rate, channels: [audio] })
  store.addAudioClip(track.id, clip)
  store.setClipStretch(track.id, clip.id, { tempoMode: 'follow', sourceBpm })
  return { store, track, clip, audio }
}

describe('clip tempo math', () => {
  it('maps follow, half, and double onto the song tempo', () => {
    expect(tempoModeFactor('follow')).toBe(1)
    expect(tempoModeFactor('half')).toBe(0.5)
    expect(tempoModeFactor('double')).toBe(2)
    expect(tempoModeFactor('lock')).toBeNull()
    expect(tempoModeFactor('free')).toBeNull()
    expect(projectBeatSpan(4, 'follow')).toBe(4)
    expect(projectBeatSpan(4, 'half')).toBe(8)
    expect(projectBeatSpan(4, 'double')).toBe(2)
    expect(effectiveClipBpm({ mode: 'follow', projectBpm: 160, sourceBpm: 80 })).toBe(160)
    expect(effectiveClipBpm({ mode: 'half', projectBpm: 160, sourceBpm: 80 })).toBe(80)
    expect(effectiveClipBpm({ mode: 'double', projectBpm: 160, sourceBpm: 80 })).toBe(320)
    expect(effectiveClipBpm({ mode: 'lock', projectBpm: 160, sourceBpm: 80, lockBpm: 80 })).toBe(80)
    expect(effectiveClipBpm({ mode: 'half', projectBpm: 140, sourceBpm: 80 })).toBe(70)
    expect(effectiveClipBpm({
      mode: 'free',
      projectBpm: 160,
      sourceBpm: 105,
      sourceSamples: 1000,
      durationSamples: 1000,
    })).toBe(105)
  })

  it('locks to the tempo the clip is already playing', () => {
    const stretch = stretchOf(1000, 80, true)
    const fromFollow = clipTempoPatch(stretch, 'lock', 160, 500)
    expect(fromFollow).toMatchObject({ tempoMode: 'lock', followTempo: false, lockBpm: 160 })
    const half = { ...stretch, tempoMode: 'half' as const, followTempo: true }
    const fromHalf = clipTempoPatch(half, 'lock', 160, 1000)
    expect(fromHalf.lockBpm).toBe(80)
    expect(clampLockBpm(80.04)).toBe(80)
    expect(lockedTimelineSamples(48000, 80, 80)).toBe(48000)
    expect(lockedTimelineSamples(48000, 80, 160)).toBe(24000)
  })

  it('doubles the bar length at half time and keeps the downbeat', () => {
    const { store, clip } = mount(80, 1, 160)
    expect(clip.startSample).toBe(0)
    expect(beatsOf(clip.durationSamples, 160)).toBeCloseTo(4, 2)
    store.setClipStretch(store.project.tracks[0].id, clip.id, { tempoMode: 'half' })
    expect(clip.stretch?.tempoMode).toBe('half')
    expect(clip.stretch?.followTempo).toBe(true)
    expect(clip.startSample).toBe(0)
    expect(beatsOf(clip.durationSamples, 160)).toBeCloseTo(8, 2)
    expect(timelineSamples(clip, store.project)).toBe(clip.durationSamples)
    store.setClipStretch(store.project.tracks[0].id, clip.id, { tempoMode: 'double' })
    expect(beatsOf(clip.durationSamples, 160)).toBeCloseTo(2, 2)
    expect(clip.startSample).toBe(0)
    store.setClipStretch(store.project.tracks[0].id, clip.id, { tempoMode: 'lock', lockBpm: 80 })
    const locked = clip.durationSamples
    expect(beatsOf(locked, 160)).toBeCloseTo(8, 2)
    expect(clip.stretch?.followTempo).toBe(false)
    expect(clip.stretch?.lockBpm).toBe(80)
    store.setTempo(120)
    expect(clip.durationSamples).toBe(locked)
    expect(effectiveClipBpm({
      mode: 'lock',
      projectBpm: store.project.tempo,
      sourceBpm: 80,
      lockBpm: clip.stretch?.lockBpm,
    })).toBe(80)
    store.setClipStretch(store.project.tracks[0].id, clip.id, { tempoMode: 'half' })
    const halfBeats = beatsOf(clip.durationSamples, 120)
    expect(halfBeats).toBeCloseTo(8, 2)
    store.setTempo(100)
    expect(beatsOf(clip.durationSamples, 100)).toBeCloseTo(halfBeats, 2)
    const bar = Math.round(4 * rate * 60 / 100)
    clip.startSample = bar
    store.setClipStretch(store.project.tracks[0].id, clip.id, { tempoMode: 'double' })
    expect(clip.startSample).toBe(bar)
    expect(beatsOf(clip.durationSamples, 100)).toBeCloseTo(2, 2)
  })

  it('keeps a free clip at the file tempo until a mode is chosen', () => {
    const project = createEmptyProject(rate)
    project.tempo = 160
    const sourceSamples = Math.round(4 * rate * 60 / 105)
    const store = new ProjectStore(project)
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    const clip: AudioClip = {
      id: 'native',
      name: 'Native',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: sourceSamples,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: stretchOf(sourceSamples, 105, false),
    }
    store.addAsset({ id: 'buf', name: 'Native', sampleRate: rate, channels: [sine(sourceSamples / rate, 110)] })
    store.addAudioClip(track.id, clip)
    expect(clipTempoMode(clip.stretch)).toBe('free')
    const native = clip.durationSamples
    store.setTempo(90)
    expect(clip.durationSamples).toBe(native)
    store.setClipStretch(track.id, clip.id, { tempoMode: 'lock' })
    expect(clip.stretch?.lockBpm).toBe(105)
    expect(clip.stretch?.tempoMode).toBe('lock')
    expect(Math.abs(clip.durationSamples - native)).toBeLessThan(2)
    store.setTempo(140)
    expect(clip.durationSamples).toBe(native)
    expect(clip.stretch?.lockBpm).toBe(105)
  })

  it('undo, redo, and reload keep the mode and the length', () => {
    const { store, track, clip } = mount(80, 1, 160)
    const followed = clip.durationSamples
    store.setClipStretch(track.id, clip.id, { tempoMode: 'half' })
    const halved = clip.durationSamples
    expect(halved).toBeGreaterThan(followed)
    store.undo()
    const undone = track.clips.find((item) => item.id === clip.id)!
    expect(store.project.tempo).toBe(160)
    expect(undone.stretch?.tempoMode ?? 'follow').not.toBe('half')
    expect(undone.durationSamples).toBe(followed)
    store.redo()
    const redone = track.clips.find((item) => item.id === clip.id)!
    expect(redone.stretch?.tempoMode).toBe('half')
    expect(redone.durationSamples).toBe(halved)

    const loaded = new ProjectStore(migrateProject(JSON.parse(JSON.stringify(store.project))))
    const saved = loaded.project.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id)!
    expect(saved.stretch?.tempoMode).toBe('half')
    expect(saved.stretch?.sourceBpm).toBe(80)
    expect(saved.durationSamples).toBe(halved)
    loaded.setTempo(100)
    expect(beatsOf(saved.durationSamples, 100)).toBeCloseTo(8, 2)
  })

  it('renders half time at 160 as the same audio as follow at 80', () => {
    const sourceBpm = 100
    const seconds = (4 * 60) / sourceBpm
    const tone = sine(seconds, 220)
    const slow = mount(sourceBpm, 1, 80, tone)
    const fast = mount(sourceBpm, 1, 160, tone)
    fast.store.setClipStretch(fast.track.id, fast.clip.id, { tempoMode: 'half' })
    expect(beatsOf(slow.clip.durationSamples, 80)).toBeCloseTo(4, 2)
    expect(beatsOf(fast.clip.durationSamples, 160)).toBeCloseTo(8, 2)
    expect(fast.clip.durationSamples).toBe(slow.clip.durationSamples)
    const at80 = renderClipChannels([tone], slow.clip, slow.store.project, 'hq')[0]
    const half = renderClipChannels([tone], fast.clip, fast.store.project, 'hq')[0]
    expect(half.length).toBe(at80.length)
    let peak = 0
    let energy = 0
    for (let i = 0; i < half.length; i++) {
      const delta = half[i] - at80[i]
      peak = Math.max(peak, Math.abs(delta))
      energy += delta * delta
    }
    const rms = Math.sqrt(energy / half.length)
    expect(peak).toBeLessThan(1e-6)
    expect(rms).toBeLessThan(1e-8)
    try {
      mkdirSync('/opt/cursor/artifacts', { recursive: true })
      writeFileSync('/opt/cursor/artifacts/tempo-follow-80.wav', Buffer.from(encodeWav([at80], rate)))
      writeFileSync('/opt/cursor/artifacts/tempo-half-160.wav', Buffer.from(encodeWav([half], rate)))
    } catch {
      /* The render comparison above is the proof. The files are only for the report. */
    }
  })

  it('changes the playback clock when the mode changes so a live tempo edit can crossfade', () => {
    const { store, track, clip } = mount(80, 1, 160)
    const follow = followClockToken(store.project)
    store.setClipStretch(track.id, clip.id, { tempoMode: 'half' })
    const half = followClockToken(store.project)
    expect(half).not.toBe(follow)
    store.setTempo(140)
    expect(followClockToken(store.project)).not.toBe(half)
    expect(clip.stretch?.tempoMode).toBe('half')
  })
})

describe('clip tempo control', () => {
  function dock(store: ProjectStore) {
    return renderToStaticMarkup(createElement(PhoneDock, {
      store,
      place: 'arrange',
      menuOpen: false,
      browseOpen: false,
      ideasOpen: false,
      onMenu() {},
      onBrowse() {},
      onIdeas() {},
      onMenuAction() {},
      onUndo() {},
      onRedo() {},
      canUndo: false,
      canRedo: false,
      playheadSample: () => 0,
    }))
  }

  it('shows the four modes only while an audio clip is selected', () => {
    const idle = new ProjectStore(createEmptyProject(rate))
    expect(dock(idle)).not.toContain('data-tempo-mode')
    const { store, track, clip } = mount(80, 1, 160)
    store.selectClip(track.id, clip.id)
    const html = dock(store)
    const sheet = renderToStaticMarkup(createElement(ClipSheet, {
      store,
      trackId: track.id,
      clip,
      onClose() {},
    }))
    expect(sheet).not.toContain('data-tempo-mode')
    expect(html).toContain('data-clip-tempo="follow"')
    expect(html).toContain('data-tempo-mode="follow"')
    expect(html).toContain('data-tempo-mode="half"')
    expect(html).toContain('data-tempo-mode="double"')
    expect(html).toContain('data-tempo-mode="lock"')
    expect(html).toContain('Source 80 · Plays 160')
    expect(html).not.toContain('aria-label="Locked BPM"')
    store.setClipStretch(track.id, clip.id, { tempoMode: 'lock', lockBpm: 80 })
    const locked = dock(store)
    expect(locked).toContain('data-clip-tempo="lock"')
    expect(locked).toContain('aria-label="Locked BPM"')
    expect(locked).toContain('Source 80 · Plays 80')
    store.selectClip(track.id, null)
    expect(dock(store)).not.toContain('data-tempo-mode')
  })
})
