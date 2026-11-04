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
import { joinAction, parseCollabTarget } from '../model/negotiate'
import { collabChoosing, connectionLine, personConnection, selfConnection, worstConnection } from '../ui/collabTab'
import { copyOf, CALL_COPY } from '../ui/chrome'
import { withoutInviteParams } from '../storage/identity'
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

  it('writes a full-word connection line and keeps the worst grade', () => {
    expect(connectionLine('Good')).toBe('Connection: Good. Audio and video are smooth.')
    expect(connectionLine('OK')).toBe('Connection: OK. Audio and video may hesitate.')
    expect(connectionLine('Poor')).toBe('Connection: Poor. Audio and video may cut out.')
    expect(worstConnection(['Good', 'OK'])).toBe('OK')
    expect(worstConnection(['Good', 'Poor', 'OK'])).toBe('Poor')
    expect(worstConnection(['Good'])).toBe('Good')
    expect(personConnection({ self: true, status: 'live', link: undefined, oneWayMs: 40 })).toBe('Good')
    expect(personConnection({ self: false, status: 'live', link: undefined, oneWayMs: null })).toBe('OK')
    expect(personConnection({
      self: false,
      status: 'live',
      link: { connection: 'failed', ice: 'failed' },
      oneWayMs: 20,
    })).toBe('Poor')
    expect(personConnection({
      self: false,
      status: 'live',
      link: { connection: 'connected', ice: 'connected' },
      oneWayMs: 120,
    })).toBe('OK')
    expect(personConnection({
      self: false,
      status: 'live',
      link: { connection: 'connected', ice: 'connected' },
      oneWayMs: 30,
    })).toBe('Good')
    expect(selfConnection({ status: 'live', oneWayMs: null, peers: 0, linksUp: 0, linksFailed: 0 })).toBe('Good')
    expect(selfConnection({ status: 'waiting', oneWayMs: 20, peers: 1, linksUp: 0, linksFailed: 0 })).toBe('OK')
    expect(selfConnection({ status: 'live', oneWayMs: 20, peers: 1, linksUp: 0, linksFailed: 1 })).toBe('Poor')
    expect(selfConnection({ status: 'live', oneWayMs: 30, peers: 1, linksUp: 1, linksFailed: 0 })).toBe('Good')
  })
})

describe('auto-join', () => {
  it('joins a shared link and ignores a stored room', () => {
    expect(joinAction({ urlCode: 'AB12CD', storedCode: '', hasParticipant: false })).toBe('auto-join')
    expect(joinAction({ urlCode: 'AB12CD', storedCode: 'AB12CD', hasParticipant: true })).toBe('auto-join')
    expect(joinAction({ urlCode: 'AB12CD', storedCode: 'ZZ99ZZ', hasParticipant: true })).toBe('auto-join')
    expect(joinAction({ urlCode: '', storedCode: 'ZZ99ZZ', hasParticipant: true })).toBe('none')
    expect(joinAction({ urlCode: '', storedCode: '', hasParticipant: false })).toBe('none')
    expect(joinAction({ urlCode: '', storedCode: 'ZZ99ZZ', hasParticipant: false })).toBe('none')
    expect(joinPlayback(true)).toBe('talk')
    expect(joinPlayback(false)).toBe('listen')
  })

  it('reads a pasted code or invite link and drops it from the address after joining', () => {
    expect(parseCollabTarget('ab12cd')).toEqual({ code: 'AB12CD', invite: '' })
    expect(parseCollabTarget('https://cueharbor.app/?session=AB12CD&invite=tokcomment&role=comment')).toEqual({
      code: 'AB12CD',
      invite: 'tokcomment',
    })
    expect(parseCollabTarget('?session=EEVEDR')).toEqual({ code: 'EEVEDR', invite: '' })
    expect(parseCollabTarget('')).toEqual({ code: '', invite: '' })
    expect(withoutInviteParams('?session=AB12CD&invite=tokcomment&role=comment')).toBe('')
    expect(withoutInviteParams('?session=AB12CD&knock=1')).toBe('?knock=1')
    expect(withoutInviteParams('')).toBe('')
  })

  it('starts on Host and Join until a session is open', () => {
    expect(copyOf(CALL_COPY, 'create').label).toBe('Host a Collab')
    expect(copyOf(CALL_COPY, 'join').label).toBe('Join a Collab')
    expect(collabChoosing('idle')).toBe(true)
    expect(collabChoosing('error')).toBe(true)
    expect(collabChoosing('rejected')).toBe(true)
    expect(collabChoosing('removed')).toBe(true)
    expect(collabChoosing('connecting')).toBe(false)
    expect(collabChoosing('waiting')).toBe(false)
    expect(collabChoosing('live')).toBe(false)
    expect(collabChoosing('reconnecting')).toBe(false)
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
