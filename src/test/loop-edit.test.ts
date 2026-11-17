import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { displayedPlayhead, transportSample } from '../model/transportSync'
import {
  formatLoopReadout,
  loopBeatComfortPx,
  loopCaptureBeats,
  loopDragLabel,
  loopGridBeats,
  loopLabelCenter,
  loopMinSamples,
  loopSnapSpec,
  magneticSnapBeat,
  planLoopAudio,
  resolveLoopDrag,
  resolveStickyLoopDrag,
  snapLoopSample,
  type LoopDrag,
} from '../model/loopEdit'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { ArrangeView } from '../ui/ArrangeView'
import { ChannelRack } from '../ui/channelRack'
import { DrumEditor } from '../ui/DrumEditor'
import { PianoRoll } from '../ui/PianoRoll'
import { TransportBar } from '../ui/TransportBar'

const rate = 48000

function song() {
  return createEmptyProject(rate)
}

function drag(mode: LoopDrag['mode'], anchor: number, start: number, end: number): LoopDrag {
  return { mode, anchor, originStart: start, originEnd: end }
}

describe('loop handle drag', () => {
  it('snaps the end, keeps the start, and refuses a loop shorter than one beat', () => {
    const project = song()
    const grid = loopGridBeats(project)
    const min = loopMinSamples(project)
    expect(grid).toBe(1)
    expect(min).toBe(24000)
    const originEnd = 4 * min
    const stretched = resolveLoopDrag(drag('end', originEnd, 0, originEnd), 5.4 * min, project, grid, false, min)
    expect(stretched.start).toBe(0)
    expect(stretched.end).toBe(5 * min)
    const tiny = resolveLoopDrag(drag('end', originEnd, 0, originEnd), 0.2 * min, project, grid, false, min)
    expect(tiny.start).toBe(0)
    expect(tiny.end - tiny.start).toBeGreaterThanOrEqual(min)
    const fine = resolveLoopDrag(drag('end', originEnd, 0, originEnd), 5.4 * min, project, grid, true, min)
    expect(fine.start).toBe(0)
    expect(fine.end).toBe(Math.round(5.4 * min))
    const pinned = resolveLoopDrag(drag('end', 4 * min, 0, 16 * min), 6 * min, project, grid, false, min)
    expect(pinned.start).toBe(0)
    expect(pinned.end).toBe(18 * min)
    expect(snapLoopSample(5.4 * min, project, grid, false)).toBe(5 * min)
    expect(snapLoopSample(5.4 * min, project, grid, true)).toBe(Math.round(5.4 * min))
  })

  it('moves the start without passing the end, and slides the whole region on the grid', () => {
    const project = song()
    const grid = loopGridBeats(project)
    const min = loopMinSamples(project)
    const end = 4 * min
    const started = resolveLoopDrag(drag('start', 0, 0, end), 2.2 * min, project, grid, false, min)
    expect(started).toEqual({ start: 2 * min, end })
    const blocked = resolveLoopDrag(drag('start', 0, 0, end), 3.8 * min, project, grid, false, min)
    expect(blocked.end).toBe(end)
    expect(blocked.end - blocked.start).toBeGreaterThanOrEqual(min)
    expect(blocked.start).toBeLessThanOrEqual(end - min)
    const moved = resolveLoopDrag(drag('move', min, min, end), min + min + 100, project, grid, false, min)
    expect(moved.end - moved.start).toBe(end - min)
    expect(moved.start).toBe(2 * min)
    const parked = resolveLoopDrag(drag('move', min, min, end), 0, project, grid, false, min)
    expect(parked.start).toBe(0)
    expect(parked.end - parked.start).toBe(end - min)
  })

  it('draws a new region and snaps sixteenths when that is the grid', () => {
    const project = song()
    const min = loopMinSamples(project)
    const drawn = resolveLoopDrag(drag('draw', 0, 0, min), 4.6 * min, project, 1, false, min)
    expect(drawn.start).toBe(0)
    expect(drawn.end).toBe(5 * min)
    const sixteenth = resolveLoopDrag(drag('end', 4 * min, 0, 4 * min), 4.3 * min, project, 0.25, false, min)
    expect(sixteenth.start).toBe(0)
    expect(sixteenth.end).toBe(4.25 * min)
    expect(loopGridBeats({ ...project, snap: false }, 0.25)).toBe(0)
    expect(loopGridBeats(project, 0)).toBe(0)
  })
})

describe('magnetic bar snap', () => {
  it('uses bars at phone zoom, beats once a beat is wide enough, and free movement when Snap is off', () => {
    const phone = loopSnapSpec({ snap: true, barBeats: 4, beatBeats: 1, pxPerQuarter: 45 })
    expect(phone.unit).toBe('bar')
    expect(phone.gridBeats).toBe(4)
    expect(phone.captureBeats / 4).toBeCloseTo(0.36, 2)
    expect(45).toBeLessThan(loopBeatComfortPx())
    const zoomed = loopSnapSpec({ snap: true, barBeats: 4, beatBeats: 1, pxPerQuarter: 80 })
    expect(zoomed.unit).toBe('beat')
    expect(zoomed.gridBeats).toBe(1)
    expect(zoomed.captureBeats).toBeCloseTo(0.36, 2)
    const six = loopSnapSpec({ snap: true, barBeats: 3, beatBeats: 0.5, pxPerQuarter: 45 })
    expect(six.unit).toBe('bar')
    expect(six.gridBeats).toBe(3)
    expect(loopSnapSpec({ snap: false, barBeats: 4, beatBeats: 1, pxPerQuarter: 45 }).unit).toBe('free')
    const far = loopSnapSpec({ snap: true, barBeats: 4, beatBeats: 1, pxPerQuarter: 8 })
    expect(far.captureBeats).toBeCloseTo(loopCaptureBeats(4, 8), 5)
    expect(far.captureBeats).toBeCloseTo(0.45 * 4, 5)
    expect(loopCaptureBeats(4, 45)).toBeCloseTo(0.36 * 4, 5)
  })

  it('sticks to a bar until the finger enters the next capture zone, and keeps the grab offset', () => {
    const project = song()
    const beat = loopMinSamples(project)
    const spec = loopSnapSpec({ snap: true, barBeats: 4, beatBeats: 1, pxPerQuarter: 45 })
    let held: number | null = 0
    const landed = [0, 0.5, 1, 2, 2.5, 2.7].map((raw) => {
      held = magneticSnapBeat(raw, spec.gridBeats, spec.captureBeats, held)
      return held
    })
    expect(landed.slice(0, 5)).toEqual([0, 0, 0, 0, 0])
    expect(landed[5]).toBe(4)
    const originEnd = 16 * beat
    const stay = resolveStickyLoopDrag(
      { mode: 'end', anchor: originEnd, originStart: 0, originEnd, heldBeat: 16 },
      originEnd + 2 * beat,
      project,
      spec,
      4 * beat,
    )
    expect(stay).toMatchObject({ start: 0, end: originEnd })
    const crossed = resolveStickyLoopDrag(
      { mode: 'end', anchor: originEnd, originStart: 0, originEnd, heldBeat: 16 },
      originEnd + 3.2 * beat,
      project,
      spec,
      4 * beat,
    )
    expect(crossed.start).toBe(0)
    expect(crossed.end).toBe(originEnd + 4 * beat)
    const jumped = resolveStickyLoopDrag(
      { mode: 'end', anchor: originEnd, originStart: 0, originEnd, heldBeat: null },
      originEnd + 3.2 * beat,
      project,
      spec,
      4 * beat,
    )
    expect(jumped.end).toBe(originEnd + 4 * beat)
  })

  it('keeps at least one bar, refuses crossing handles, and snaps a move onto the next bar', () => {
    const project = song()
    const beat = loopMinSamples(project)
    const spec = loopSnapSpec({ snap: true, barBeats: 4, beatBeats: 1, pxPerQuarter: 45 })
    const shrunk = resolveStickyLoopDrag(
      { mode: 'end', anchor: 4 * beat, originStart: 0, originEnd: 4 * beat, heldBeat: 4 },
      0,
      project,
      spec,
      4 * beat,
    )
    expect(shrunk.start).toBe(0)
    expect(shrunk.end - shrunk.start).toBeGreaterThanOrEqual(4 * beat)
    const blocked = resolveStickyLoopDrag(
      { mode: 'start', anchor: 0, originStart: 0, originEnd: 8 * beat, heldBeat: 0 },
      20 * beat,
      project,
      spec,
      4 * beat,
    )
    expect(blocked.end).toBe(8 * beat)
    expect(blocked.start).toBeLessThanOrEqual(blocked.end - 4 * beat)
    expect(blocked.end - blocked.start).toBeGreaterThanOrEqual(4 * beat)
    const moved = resolveStickyLoopDrag(
      { mode: 'move', anchor: 0, originStart: 0, originEnd: 16 * beat, heldBeat: 0 },
      3.2 * beat,
      project,
      spec,
      4 * beat,
    )
    expect(moved.start).toBe(4 * beat)
    expect(moved.end - moved.start).toBe(16 * beat)
    const beats = loopSnapSpec({ snap: true, barBeats: 4, beatBeats: 1, pxPerQuarter: 90 })
    let held: number | null = 4
    const steps = [4, 4.3, 4.7].map((raw) => {
      held = magneticSnapBeat(raw, beats.gridBeats, beats.captureBeats, held)
      return held
    })
    expect(steps).toEqual([4, 4, 5])
    const loose = loopSnapSpec({ snap: false, barBeats: 4, beatBeats: 1, pxPerQuarter: 45 })
    const free = resolveStickyLoopDrag(
      { mode: 'end', anchor: 16 * beat, originStart: 0, originEnd: 16 * beat, heldBeat: 16 },
      16 * beat + Math.round(1.2 * beat),
      project,
      loose,
      1,
    )
    expect(free.start).toBe(0)
    expect(free.end).toBe(16 * beat + Math.round(1.2 * beat))
    const crossed = resolveStickyLoopDrag(
      { mode: 'end', anchor: 1000, originStart: 0, originEnd: 1000, heldBeat: 0 },
      10,
      project,
      loose,
      1,
    )
    expect(crossed.end).toBeGreaterThan(crossed.start)
  })

  it('labels the length and the start bar', () => {
    const project = song()
    const beat = loopMinSamples(project)
    const label = loopDragLabel(project, 0, 8 * beat)
    expect(label.length).toBe('2 bars')
    expect(label.bar).toBe('1')
    expect(label.text).toBe('2 bars / 1')
    const later = loopDragLabel(project, 4 * beat, 16 * beat)
    expect(later.text).toBe('3 bars / 2')
  })

  it('extends a playing loop by a bar without restarting audio that is still inside it', () => {
    const project = song()
    project.loopEnabled = true
    project.loopStartSample = 0
    project.loopEndSample = 8 * 24000
    const extended = planLoopAudio(
      { ...project, loopEndSample: 16 * 24000 },
      { nowLinear: 4 * 24000, scheduledUntil: 8 * 24000, wrapQueued: false },
    )
    expect(extended).toEqual({ action: 'extend', from: 8 * 24000, to: 16 * 24000 })
    const inside = planLoopAudio(
      { ...project, loopEndSample: 12 * 24000 },
      { nowLinear: 4 * 24000, scheduledUntil: 8 * 24000, wrapQueued: false },
    )
    expect(inside.action).not.toBe('restart')
  })
})

describe('loop length readout', () => {
  it('says how many bars, or bars.beats.ticks, and the start and end', () => {
    const project = song()
    const beat = loopMinSamples(project)
    const four = formatLoopReadout(project, 0, 16 * beat)
    expect(four.length).toBe('4 bars')
    expect(four.span).toBe('1 → 5')
    expect(four.text).toBe('4 bars · 1 → 5')
    const partial = formatLoopReadout(project, 0, 10 * beat)
    expect(partial.length).toBe('2.2.0')
    expect(partial.span).toBe('1.1.0 → 3.3.0')
    const one = formatLoopReadout(project, 0, 4 * beat)
    expect(one.length).toBe('1 bar')
    expect(loopLabelCenter(0, 800, 100, 0, 400)).toBe(306)
    expect(loopLabelCenter(100, 100, 80, 0, 400)).toBe(150)
  })

  it('shows the same length on every loop ruler', () => {
    const store = new ProjectStore(song())
    const engine = {
      positionSamples: 0,
      status: 'stopped' as const,
      subscribe: () => () => undefined,
      currentTimelineSample: () => 0,
      seek() {},
      unlock() {},
      resume: async () => undefined,
      liveNoteOn() {},
      liveNoteOff() {},
      previewPitches() {},
      stopPreview() {},
      previewPcm() {},
      levels: () => ({ master: 0, input: 0, talk: 0, tracks: {} }),
    }
    const transport = renderToStaticMarkup(createElement(TransportBar, {
      store,
      engine: engine as never,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    expect(transport).not.toContain('data-loop-readout="transport"')
    expect(transport).not.toContain('>More<')
    expect(transport).not.toContain('>Fine<')

    const arrange = renderToStaticMarkup(createElement(ArrangeView, {
      store,
      engine,
      session: { state: { participants: [], selfId: 'me' } },
      onSeek() {},
      onOpenPiano() {},
      onPerform() {},
      onQuickPunch() {},
      onAnalyze() {},
    } as never))
    expect(arrange).toContain('data-loop-region="arrange"')
    expect(arrange).toContain('data-loop-edge="end"')
    expect(arrange).toContain('data-loop-length="4 bars"')
    expect(arrange).toContain('data-loop="off"')

    const rack = renderToStaticMarkup(createElement(ChannelRack, { store, engine }))
    expect(rack).toContain('data-loop-region="rack"')
    expect(rack).toContain('data-loop-edge="start"')
    expect(rack).toContain('data-loop-length="4 bars"')

    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    store.selectClip(track.id, track.midiClips[0].id, true)
    const piano = renderToStaticMarkup(createElement(PianoRoll, { store, engine: engine as never }))
    expect(piano).toContain('data-loop-region="piano"')
    expect(piano).toContain('data-playhead="piano"')
    const drums = renderToStaticMarkup(createElement(DrumEditor, { store, engine: engine as never }))
    expect(drums).toContain('data-loop-region="drums"')
    expect(drums).toContain('Loop end')
  })
})

describe('playback wrap at a new loop end', () => {
  it('folds the shared playhead inside the changed loop and plans the audio', () => {
    const project = song()
    project.loopEnabled = true
    project.loopStartSample = 0
    project.loopEndSample = 16 * 24000
    const playing = 300000
    expect(transportSample(playing, project)).toBe(playing)
    project.loopEndSample = 8 * 24000
    const heard = transportSample(playing, project)
    expect(heard).toBeGreaterThanOrEqual(0)
    expect(heard).toBeLessThan(project.loopEndSample)
    const views = ['arrange', 'piano', 'drums'].map(() => displayedPlayhead(playing, project))
    expect(new Set(views).size).toBe(1)
    expect(views[0]).toBe(heard)
    const shrunk = planLoopAudio(project, { nowLinear: playing, scheduledUntil: 16 * 24000, wrapQueued: false })
    expect(shrunk).toEqual({ action: 'restart', from: heard, to: project.loopEndSample, reason: 'outside' })
    const extended = planLoopAudio(
      { ...project, loopEndSample: 20 * 24000 },
      { nowLinear: 10000, scheduledUntil: 8 * 24000, wrapQueued: false },
    )
    expect(extended).toEqual({ action: 'extend', from: 8 * 24000, to: 20 * 24000 })
    const queued = planLoopAudio(
      { ...project, loopEndSample: 20 * 24000 },
      { nowLinear: 10000, scheduledUntil: 8 * 24000, wrapQueued: true },
    )
    expect(queued.action).toBe('restart')
  })

  it('keeps a loop drag as one undo step', () => {
    const store = new ProjectStore(song())
    const before = store.project.loopEndSample
    expect(store.project.loopEnabled).toBe(false)
    store.setLoop(true, 0, before, true)
    store.setLoop(true, 0, before + 48000, true)
    store.endDraft()
    expect(store.project.loopEnabled).toBe(true)
    expect(store.project.loopEndSample).toBe(before + 48000)
    store.undo()
    expect(store.project.loopEndSample).toBe(before)
    expect(store.project.loopEnabled).toBe(false)
    store.redo()
    expect(store.project.loopEndSample).toBe(before + 48000)
  })
})
