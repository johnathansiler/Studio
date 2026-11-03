import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  AWARE_LIST_MAX,
  AwarenessChannel,
  PRESENCE_COLORS,
  awareRelayDue,
  chooseRollCursor,
  currentEditCursor,
  editorsOnTrack,
  localAwareness,
  noteOutline,
  onPresencePoke,
  outlinePeer,
  presenceColor,
  presenceInitial,
  relayAware,
  setEditCursor,
  type AwareMessage,
  type AwarenessOptions,
  type RemotePresence,
} from '../remote/presence'
import { RemoteRollCursors, RemoteTimeline, TrackChips } from '../ui/presenceMarks'

function harness(opts: AwarenessOptions = {}) {
  let now = 1_000
  const sent: AwareMessage[] = []
  const timers: { id: number; fn: () => void; at: number }[] = []
  let seq = 0
  const channel = new AwarenessChannel((message) => sent.push(message), {
    now: () => now,
    throttleMs: 100,
    urgentMs: 40,
    heartbeatMs: 500,
    timeoutMs: 1_000,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.push({ id, fn, at: now + ms })
      return id
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
    ...opts,
  })
  return {
    channel,
    sent,
    get now() { return now },
    set now(value: number) { now = value },
    fire() {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
        timer.fn()
      }
    },
  }
}

function state(patch: Partial<Parameters<AwarenessChannel['publish']>[1]> = {}) {
  return localAwareness({
    name: 'Ada',
    cursorSample: 0,
    songBeat: 0,
    trackId: 'drums',
    clipIds: [],
    noteIds: [],
    playing: false,
    recording: false,
    rollOpen: false,
    clip: null,
    rollTrackId: null,
    pointer: null,
    ...patch,
  })
}

function person(patch: Partial<RemotePresence> & Pick<RemotePresence, 'id' | 'name'>): RemotePresence {
  return {
    color: '#e25b45',
    cursorSample: 48000,
    rollBeat: 1,
    rollPitch: 60,
    rollClipId: 'clip-1',
    selectedClipIds: ['clip-1'],
    selectedNoteIds: ['note-1'],
    trackId: 'drums',
    playing: true,
    recording: true,
    seenAt: 0,
    ...patch,
  }
}

describe('awareness relay', () => {
  it('assigns a stable color and ignores a spoofed id, name, and color', () => {
    expect(presenceColor('ada')).toBe(presenceColor('ada'))
    expect(PRESENCE_COLORS).toContain(presenceColor('ada'))
    expect(presenceInitial(' ada ')).toBe('A')
    expect(presenceInitial('')).toBe('?')
    const relay = relayAware('real-id', 'Ada', {
      t: 'aware',
      id: 'fake',
      name: 'Eve',
      color: '#000000',
      cursorSample: 48000.4,
      rollBeat: 1.23456,
      rollPitch: 60.2,
      rollClipId: 'clip-1',
      clips: ['clip-1', 'clip-1', 'nope', 4, 'x'.repeat(80)],
      notes: ['note-1'],
      trackId: 'drums',
      playing: true,
      recording: true,
    })
    expect(relay).toMatchObject({
      t: 'aware',
      id: 'real-id',
      name: 'Ada',
      color: presenceColor('real-id'),
      cursorSample: 48000,
      rollBeat: 1.235,
      rollPitch: 60,
      rollClipId: 'clip-1',
      clips: ['clip-1', 'nope', 'x'.repeat(64)],
      notes: ['note-1'],
      trackId: 'drums',
      playing: true,
      recording: true,
    })
    expect(relay?.color).not.toBe('#000000')
    expect(relayAware('real-id', 'Ada', { cursorSample: Number.NaN })).toBeNull()
    expect(relayAware('', 'Ada', { cursorSample: 1 })).toBeNull()
    const flood = relayAware('real-id', 'Ada', { cursorSample: 1, clips: Array.from({ length: 40 }, (_, index) => `c${index}`) })
    expect(flood?.clips).toHaveLength(AWARE_LIST_MAX)
    expect(awareRelayDue(0, 1_000)).toBe(true)
    expect(awareRelayDue(1_000, 1_020)).toBe(false)
    expect(awareRelayDue(1_000, 1_040)).toBe(true)
  })

  it('throttles cursor motion, sends recording without waiting the full window, and heartbeats', () => {
    const room = harness()
    expect(room.channel.publish('self', state({ cursorSample: 100 }))).toBe(true)
    expect(room.sent).toHaveLength(1)
    expect(room.sent[0].cursorSample).toBe(100)
    room.now = 1_010
    expect(room.channel.publish('self', state({ cursorSample: 400 }))).toBe(false)
    room.now = 1_030
    expect(room.channel.publish('self', state({ cursorSample: 900 }))).toBe(false)
    expect(room.sent).toHaveLength(1)
    room.now = 1_110
    room.fire()
    expect(room.sent.map((message) => message.cursorSample)).toEqual([100, 900])
    room.now = 1_120
    expect(room.channel.publish('self', state({ cursorSample: 900, recording: true, playing: true }))).toBe(false)
    room.now = 1_160
    room.fire()
    expect(room.sent.at(-1)).toMatchObject({ recording: true, playing: true, cursorSample: 900, name: 'Ada', color: presenceColor('self') })
    const before = room.sent.length
    room.now = 1_200
    expect(room.channel.publish('self', state({ cursorSample: 900, recording: true, playing: true }))).toBe(false)
    expect(room.sent).toHaveLength(before)
    room.now = 1_700
    expect(room.channel.publish('self', state({ cursorSample: 900, recording: true, playing: true }))).toBe(true)
    expect(room.sent).toHaveLength(before + 1)
    room.channel.dispose()
  })

  it('drops a peer on leave immediately and on timeout, and ignores our own echo', () => {
    const room = harness()
    room.channel.setSelf('self')
    const message = relayAware('ada', 'Ada', { cursorSample: 10, trackId: 'drums', clips: ['clip-1'], notes: ['note-1'], playing: true, recording: true })!
    expect(room.channel.ingest(message)).toBe(true)
    expect(room.channel.ingest({ ...message, id: 'self', name: 'Me' })).toBe(false)
    expect(room.channel.peersView().map((peer) => peer.id)).toEqual(['ada'])
    expect(room.channel.ingest({ t: 'chat' })).toBe(false)
    room.now = 1_500
    expect(room.channel.expire()).toEqual([])
    expect(room.channel.forget('ada')).toBe(true)
    expect(room.channel.peersView()).toEqual([])
    expect(room.channel.ingest(message)).toBe(true)
    room.now = 2_600
    expect(room.channel.expire()).toEqual(['ada'])
    expect(room.channel.peersView()).toEqual([])
    room.channel.ingest(message)
    room.channel.clear()
    expect(room.channel.peersView()).toEqual([])
    room.channel.dispose()
  })
})

describe('local awareness', () => {
  const clip = {
    id: 'clip-1',
    startBeat: 4,
    durationBeats: 4,
    loop: true,
    notes: [{ startBeat: 0, durationBeats: 1 }],
  }

  it('follows the playhead inside the roll, and the pointer when it is on that clip', () => {
    const folded = chooseRollCursor({ open: true, clip, songBeat: 9, pointer: null })
    expect(folded.rollBeat).toBe(1)
    expect(folded.rollClipId).toBe('clip-1')
    expect(folded.rollPitch).toBeNull()
    const pointed = localAwareness({
      name: 'Bo',
      cursorSample: 96000,
      songBeat: 9,
      trackId: 'other',
      clipIds: ['audio-1', 'audio-1'],
      noteIds: ['note-9'],
      playing: true,
      recording: false,
      rollOpen: true,
      clip,
      rollTrackId: 'keys',
      pointer: { clipId: 'clip-1', beat: 2.25, pitch: 64.4 },
    })
    expect(pointed).toMatchObject({
      name: 'Bo',
      cursorSample: 96000,
      rollBeat: 2.25,
      rollPitch: 64,
      rollClipId: 'clip-1',
      trackId: 'keys',
      selectedClipIds: ['audio-1'],
      selectedNoteIds: ['note-9'],
      playing: true,
      recording: false,
    })
    const closed = chooseRollCursor({ open: false, clip, songBeat: 9, pointer: { clipId: 'clip-1', beat: 1, pitch: 60 } })
    expect(closed).toEqual({ rollBeat: null, rollPitch: null, rollClipId: null })
    expect(chooseRollCursor({ open: true, clip: { ...clip, loop: false }, songBeat: 3, pointer: null }).rollBeat).toBeNull()
  })

  it('quantizes the edit cursor and pokes once per change', () => {
    let pokes = 0
    const stop = onPresencePoke(() => { pokes += 1 })
    setEditCursor(null)
    setEditCursor({ clipId: 'clip-1', beat: 1.234, pitch: 60.6 })
    setEditCursor({ clipId: 'clip-1', beat: 1.24, pitch: 61 })
    expect(pokes).toBe(1)
    expect(currentEditCursor()).toEqual({ clipId: 'clip-1', beat: 1.24, pitch: 61 })
    setEditCursor(null)
    expect(currentEditCursor()).toBeNull()
    expect(pokes).toBe(2)
    stop()
  })
})

describe('presence marks', () => {
  const ada = person({ id: 'ada', name: 'Ada', color: '#e25b45' })
  const bo = person({
    id: 'bo',
    name: 'Bo',
    color: '#6cb6e0',
    trackId: 'keys',
    recording: false,
    selectedClipIds: ['other'],
    selectedNoteIds: [],
    rollClipId: null,
    rollBeat: null,
  })

  it('draws avatar chips, clip outlines, timeline and piano cursors, and a recording badge', () => {
    expect(editorsOnTrack([ada, bo], 'drums').map((peer) => peer.id)).toEqual(['ada'])
    expect(outlinePeer([ada, bo], 'clip-1')?.id).toBe('ada')
    expect(noteOutline([ada, bo], 'note-1', 'clip-1')?.id).toBe('ada')
    expect(noteOutline([ada], 'note-1', 'somewhere-else')).toBeNull()
    const chips = renderToStaticMarkup(createElement(TrackChips, { trackId: 'drums', peers: [ada, bo] }))
    expect(chips).toContain('data-presence-track="drums"')
    expect(chips).toContain('data-presence="ada"')
    expect(chips).toContain('>Ada<')
    expect(chips).toContain('data-recording-badge="1"')
    expect(chips).toContain('>Recording<')
    expect(chips).not.toContain('data-presence="bo"')
    const timeline = renderToStaticMarkup(createElement(RemoteTimeline, { peers: [ada], sampleRate: 48000, px: 100 }))
    expect(timeline).toContain('data-remote-cursor="ada"')
    expect(timeline).toContain('data-cursor-where="timeline"')
    expect(timeline).toContain('left:100px')
    expect(timeline).toContain('>Recording<')
    const roll = renderToStaticMarkup(createElement(RemoteRollCursors, { peers: [ada, bo], clipId: 'clip-1', pxBeat: 70 }))
    expect(roll).toContain('data-cursor-where="piano"')
    expect(roll).toContain('left:70px')
    expect(roll).not.toContain('data-remote-cursor="bo"')
    expect(renderToStaticMarkup(createElement(TrackChips, { trackId: 'missing', peers: [ada] }))).toBe('')
  })

  it('keeps the chip at least 40px on phone and fold, with the name and Recording readable', async () => {
    const html = renderToStaticMarkup(createElement('div', { className: 'pl-head', style: { width: 180 } }, createElement(TrackChips, { trackId: 'drums', peers: [ada] })))
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const shell of ['phone', 'fold']) {
        await page.setViewportSize(shell === 'phone' ? { width: 390, height: 844 } : { width: 768, height: 900 })
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="shell ${shell}">${html}</div></body></html>`, { waitUntil: 'load' })
        const box = await page.locator('.presence-chips').boundingBox()
        const badge = await page.locator('[data-recording-badge="1"]').boundingBox()
        const name = await page.locator('.presence-name').innerText()
        expect(box && box.height).toBeGreaterThanOrEqual(40)
        expect(box && box.width).toBeGreaterThanOrEqual(40)
        expect(name).toBe('Ada')
        expect(badge && badge.height).toBeGreaterThan(10)
        expect(badge && badge.width).toBeGreaterThan(40)
        const label = await page.locator('.remote-cursor-label').count()
        expect(label).toBe(0)
      }
      const timeline = renderToStaticMarkup(createElement('div', { className: 'timeline-inner', style: { position: 'relative', height: 160, width: 320 } },
        createElement(RemoteTimeline, { peers: [ada], sampleRate: 48000, px: 100 }),
        createElement('div', { className: 'clip', 'data-clip': 'clip-1', style: { position: 'absolute', left: 80, top: 40, width: 80, height: 48 } }, 'Take'),
      ))
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="shell phone">${timeline}</div></body></html>`, { waitUntil: 'load' })
      const overlap = await page.evaluate(() => {
        const label = document.querySelector('.remote-cursor-label')!.getBoundingClientRect()
        const clip = document.querySelector('[data-clip]')!.getBoundingClientRect()
        const cursor = document.querySelector('.remote-cursor') as HTMLElement
        return {
          covers: !(label.bottom <= clip.top || label.top >= clip.bottom || label.right <= clip.left || label.left >= clip.right),
          events: getComputedStyle(cursor).pointerEvents,
        }
      })
      expect(overlap.covers).toBe(false)
      expect(overlap.events).toBe('none')
    } finally {
      await browser.close()
    }
  })
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/arrangeSpace.css', 'src/ui/presence.css']
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')
