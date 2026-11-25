import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { keyboardPitch } from '../model/keyboardPlay'
import { clampKeyStart, noteName, readKeyStart, stepKeyStart, writeKeyStart } from '../model/keyShift'
import { editorForGesture, instrumentFace } from '../model/editorOpen'
import { miniPads } from '../ui/miniKeys'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { Bass808Panel } from '../ui/Bass808Panel'

describe('semitone keyboard shift', () => {
  it('moves the played note by one semitone and remembers it per instrument', () => {
    expect(noteName(29)).toBe('F1')
    expect(stepKeyStart(48, 1, 12)).toBe(49)
    expect(stepKeyStart(48, -1, 12)).toBe(47)
    expect(clampKeyStart(200, 12)).toBe(116)
    expect(clampKeyStart(-4, 12)).toBe(0)
    expect(keyboardPitch(60, 0, 1)).toBe(61)
    expect(keyboardPitch(60, 0, -1)).toBe(59)
    expect(keyboardPitch(60, 1, 0)).toBe(72)
    const lowest = (pads: { naturals: { pitch: number }[]; sharps: { pitch: number }[] }) => Math.min(...pads.naturals.map((pad) => pad.pitch), ...pads.sharps.map((pad) => pad.pitch))
    const shifted = miniPads(0, 1)
    const home = miniPads(0)
    expect(lowest(shifted) - lowest(home)).toBe(1)
    expect(shifted.naturals.concat(shifted.sharps).some((pad) => pad.pitch === home.naturals[0].pitch + 1)).toBe(true)
    const memory = {
      data: new Map<string, string>(),
      getItem(key: string) { return this.data.get(key) ?? null },
      setItem(key: string, value: string) { this.data.set(key, value) },
    }
    writeKeyStart('bass808', 41, 13, memory)
    writeKeyStart('synth', 60, 25, memory)
    expect(readKeyStart('bass808', 36, 13, memory)).toBe(41)
    expect(readKeyStart('synth', 36, 25, memory)).toBe(60)
    expect(readKeyStart('sampler', 36, 13, memory)).toBe(36)
  })
})

describe('instrument plugin reopen', () => {
  it('opens the 808 plugin again after it is closed, and keeps the piano roll on its own button', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.addQuickTrack('bass808')!
    expect(instrumentFace(store.track(id))).toBe('bass')
    expect(store.bassTrackId).toBe(id)
    store.closeBass()
    expect(store.bassTrackId).toBeNull()
    expect(editorForGesture('select-track', 'midi', store.track(id))).toBe('bass')
    expect(editorForGesture('tap-clip', 'midi', store.track(id))).toBe('bass')
    store.showBass(id)
    expect(store.bassTrackId).toBe(id)
    store.closeBass()
    store.showBass(id)
    expect(store.bassTrackId).toBe(id)
    expect(editorForGesture('edit-notes', 'midi', store.track(id))).toBe('piano')

    const keys = store.project.tracks.find((track) => track.type === 'midi' && track.instrument !== 'bass808')!
    store.setTrackInstrument(keys.id, 'sampler')
    expect(instrumentFace(store.track(keys.id))).toBe('rack')
    store.showRack(keys.id)
    store.showRack(keys.id)
    expect(store.rackTrackId).toBe(keys.id)
    store.setTrackInstrument(keys.id, 'synth')
    store.showPatch(keys.id)
    store.showPatch(keys.id)
    expect(store.patchTrackId).toBe(keys.id)

    const html = renderToStaticMarkup(createElement(Bass808Panel, {
      store,
      engine: { status: 'stopped', sampleRate: 48000, unlock() {}, playThrough() {}, releaseThrough() {}, currentTimelineSample: () => 0 } as unknown as AudioEngine,
      trackId: id,
      onClose() {},
      onRecord() {},
      onStop() {},
      onPlay() {},
      onPiano() {},
    }))
    expect(html).toContain('aria-label="Piano Roll"')
    expect(html).toContain('Semitone down')
    expect(html).toContain('Semitone up')
    expect(html).toContain('aria-label="Key C2"')
  })
})
