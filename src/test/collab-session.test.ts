import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  automaticMonitorMode,
  connectionWord,
  joinPlayback,
  liveMediaTracks,
  MESH_TRANSCEIVER_KINDS,
  needsFreshCapture,
  offerAfterVideoAttach,
  previewPlayback,
  rejoinMediaPlan,
  relayOnlyGather,
  remoteTrackSlot,
  videoMLinesReady,
  videoSendChanged,
} from '../model/callVideo'
import { joinAction } from '../model/negotiate'
import { shareSessionLink } from '../ui/share'
import { SETUP_PLAIN } from '../ui/collabCopy'
import { ViewSwitcher } from '../ui/ViewSwitcher'

describe('collab tab and setup copy', () => {
  it('draws Collab as the first tab', () => {
    const html = renderToStaticMarkup(createElement(ViewSwitcher, {
      active: 'arrange',
      collabShown: false,
      phonePane: 'edit',
      collabBadge: false,
      onView: () => undefined,
      onCollab: () => undefined,
    }))
    expect(html.indexOf('Collab')).toBeGreaterThan(-1)
    expect(html.indexOf('Collab')).toBeLessThan(html.indexOf('Arrange'))
    expect(html.indexOf('Arrange')).toBeLessThan(html.indexOf('Mix'))
  })

  it('keeps Hear myself and Fix delay, and does not name Opus, Ping, or Jam', () => {
    expect(SETUP_PLAIN.hear.label).toBe('Hear myself')
    expect(SETUP_PLAIN.calibrate.label).toBe('Fix delay')
    expect(SETUP_PLAIN.hear.detail.length).toBeGreaterThan(8)
    expect(SETUP_PLAIN.calibrate.detail.length).toBeGreaterThan(8)
    const text = JSON.stringify(SETUP_PLAIN)
    expect(text).not.toMatch(/Opus|Ping|Jam/)
  })
})

describe('automatic call sound and connection grade', () => {
  it('uses Opus at the quality cap with no switch', () => {
    expect(automaticMonitorMode).toBe('opus')
  })

  it('grades the path without showing the raw counters', () => {
    expect(connectionWord({ status: 'live', failed: false, oneWayMs: 40 })).toBe('Good')
    expect(connectionWord({ status: 'live', failed: false, oneWayMs: 120 })).toBe('OK')
    expect(connectionWord({ status: 'live', failed: false, oneWayMs: 240 })).toBe('Poor')
    expect(connectionWord({ status: 'reconnecting', failed: false, oneWayMs: 20 })).toBe('OK')
    expect(connectionWord({ status: 'live', failed: true, oneWayMs: 20 })).toBe('Poor')
    expect(connectionWord({ status: 'live', failed: false, oneWayMs: null })).toBe('Good')
  })
})

describe('auto-join', () => {
  it('joins a shared link, reconnects the same browser, and resumes a stored room', () => {
    expect(joinAction({ urlCode: 'AB12CD', storedCode: '', hasParticipant: false })).toBe('auto-join')
    expect(joinAction({ urlCode: 'AB12CD', storedCode: 'AB12CD', hasParticipant: true })).toBe('reconnect-url')
    expect(joinAction({ urlCode: '', storedCode: 'ZZ99ZZ', hasParticipant: true })).toBe('resume-stored')
    expect(joinAction({ urlCode: '', storedCode: '', hasParticipant: false })).toBe('none')
    expect(joinPlayback(true)).toBe('talk')
    expect(joinPlayback(false)).toBe('listen')
  })
})

describe('copy link', () => {
  it('shares on a phone and copies everywhere else', async () => {
    const shared: string[] = []
    const copied: string[] = []
    const phone = await shareSessionLink('https://cueharbor.app/?session=AB12CD', {
      phone: true,
      share: async (data) => { shared.push(data.url || '') },
      writeText: async (value) => { copied.push(value) },
    })
    expect(phone).toBe('shared')
    expect(shared).toEqual(['https://cueharbor.app/?session=AB12CD'])
    expect(copied).toEqual([])
    const desk = await shareSessionLink('https://cueharbor.app/?session=AB12CD', {
      phone: false,
      share: async () => { shared.push('desk') },
      writeText: async (value) => { copied.push(value) },
    })
    expect(desk).toBe('copied')
    expect(copied).toEqual(['https://cueharbor.app/?session=AB12CD'])
    const aborted = await shareSessionLink('https://cueharbor.app/?session=AB12CD', {
      phone: true,
      share: async () => { throw new DOMException('no', 'AbortError') },
      writeText: async () => { copied.push('after-abort') },
    })
    expect(aborted).toBe('aborted')
    expect(copied).not.toContain('after-abort')
  })
})

describe('relay video and rejoin preview', () => {
  it('adds both video m-lines before the offer', () => {
    expect([...MESH_TRANSCEIVER_KINDS]).toEqual(['audio', 'audio', 'video', 'video'])
    expect(videoMLinesReady([...MESH_TRANSCEIVER_KINDS])).toBe(true)
  })

  it('shows remote video on a relay-only path without rejoining', () => {
    const gathered = { host: 0, srflx: 0, relay: 2, prflx: 0 }
    expect(relayOnlyGather(gathered)).toBe(true)
    expect(relayOnlyGather({ host: 1, srflx: 0, relay: 1, prflx: 0 })).toBe(false)
    expect(videoSendChanged(null, null)).toBe(false)
    expect(videoSendChanged(null, { id: 'cam', live: true })).toBe(true)
    expect(offerAfterVideoAttach({ trackBecameLive: true, relayOnly: true, alreadyRestarted: false })).toEqual({ renegotiate: true, iceRestart: true })
    expect(offerAfterVideoAttach({ trackBecameLive: true, relayOnly: false, alreadyRestarted: false })).toEqual({ renegotiate: true, iceRestart: false })
    expect(offerAfterVideoAttach({ trackBecameLive: true, relayOnly: true, alreadyRestarted: true })).toEqual({ renegotiate: true, iceRestart: false })
    const remote = previewPlayback({ readyState: 'live' })
    expect(remote).toEqual({ attach: true, playsInline: true, play: true })
    expect(remoteTrackSlot({ index: -1, kind: 'video', musicFilled: true, cameraFilled: false })).toBe('camera')
    expect(remoteTrackSlot({ index: 2, kind: 'video', musicFilled: true, cameraFilled: true })).toBe('camera')
  })

  it('drops ended tracks after leave and renders both views once capture returns', () => {
    const ended = rejoinMediaPlan({
      audioLive: false,
      videoLive: false,
      camOn: true,
      selfTrack: { readyState: 'ended' },
      remoteTrack: { readyState: 'ended' },
    })
    expect(ended).toEqual({ recapture: true, showSelf: false, showRemote: false })
    expect(liveMediaTracks([{ readyState: 'ended' }, { readyState: 'live' }])).toEqual([{ readyState: 'live' }])
    expect(needsFreshCapture({ audioLive: true, videoLive: false, camOn: true })).toBe(true)
    const again = rejoinMediaPlan({
      audioLive: true,
      videoLive: true,
      camOn: true,
      selfTrack: { readyState: 'live' },
      remoteTrack: { readyState: 'live' },
    })
    expect(again).toEqual({ recapture: false, showSelf: true, showRemote: true })
    expect(previewPlayback({ readyState: 'ended' }).attach).toBe(false)
  })
})
