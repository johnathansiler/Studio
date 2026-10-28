import { describe, expect, it } from 'vitest'
import { createEmptyProject, type Project } from '../model/types'
import { containsAudio, syncMessageOk } from '../state/ops'
import {
  selectArrange,
  selectBeats,
  selectClip,
  selectKnock,
  selectMaster,
  selectMixer,
  selectPiano,
  selectPlugin,
  selectQuantize,
  selectScale,
  selectSession,
  selectTransport,
} from '../state/select'
import { ProjectStore } from '../state/store'

function pair() {
  const host = new ProjectStore(createEmptyProject(48000, 'Sync'))
  const guest = new ProjectStore(structuredClone(host.project) as Project)
  return { host, guest }
}

function deliver(from: ProjectStore, to: ProjectStore) {
  const ops = from.sync.drain()
  if (ops.length) to.applyRemoteOps(ops)
}

describe('project surfaces', () => {
  it('shows one edit in arrange, mix, session, beats, piano, and panels', () => {
    const store = new ProjectStore(createEmptyProject(48000, 'Surfaces'))
    const audio = store.project.tracks.find((track) => track.type === 'audio')!
    const midi = store.project.tracks.find((track) => track.type === 'midi')!
    store.setTempo(103)
    store.setTimeSignature(3, 4)
    store.setMasterVolume(0.4)
    store.updateTrack(audio.id, { volume: 0.33, pan: -0.2, mute: true })
    store.addPlugin(audio.id, 'eq')
    const plugin = store.track(audio.id)!.plugins.at(-1)!
    store.updatePlugin(audio.id, plugin.id, { wet: 0.25, params: { gain: 2 } })
    store.setScale({ root: 7, scale: 'dorian' })
    store.addMidiClip(midi.id, 0)
    store.addNote(midi.id, store.selectedMidiClipId!, { pitch: 64, startBeat: 0, durationBeats: 1, velocity: 0.8 })
    const channel = selectBeats(store).pattern!.channels[0]
    store.setStep(channel.id, 1, true)
    store.addDevice(midi.id, 'knock')
    store.openQuantize()

    expect(selectArrange(store).tempo).toBe(103)
    expect(selectArrange(store).timeSignature).toEqual({ numerator: 3, denominator: 4 })
    expect(selectArrange(store).tracks.find((track) => track.id === audio.id)?.mute).toBe(true)
    expect(selectMixer(store).tracks.find((track) => track.id === audio.id)).toMatchObject({ volume: 0.33, pan: -0.2, mute: true })
    expect(selectMixer(store).masterVolume).toBe(0.4)
    expect(selectTransport(store).tempo).toBe(103)
    expect(selectTransport(store).masterVolume).toBe(0.4)
    expect(selectSession(store).tempo).toBe(103)
    expect(selectSession(store).tracks.find((track) => track.id === audio.id)?.volume).toBe(0.33)
    expect(selectBeats(store).tempo).toBe(103)
    expect(selectBeats(store).pattern!.channels[0].cells[1].on).toBe(true)
    expect(selectPiano(store).clip?.notes.map((note) => note.pitch)).toEqual([64])
    expect(selectPiano(store).scale.root).toBe(7)
    expect(selectScale(store).scale).toBe('dorian')
    expect(selectPlugin(store, audio.id, plugin.id)?.wet).toBe(0.25)
    expect(selectPlugin(store, audio.id, plugin.id)?.params.gain).toBe(2)
    expect(selectMaster(store).volume).toBe(0.4)
    expect(selectQuantize(store).open).toBe(true)
    expect(selectKnock(store).device?.kind).toBe('knock')
    const clipId = audio.clips[0]?.id
    if (clipId) expect(selectClip(store, audio.id, clipId).clip?.id).toBe(clipId)
  })
})

describe('two device sync', () => {
  it('carries tempo, mixer, plugin, scale, and beats from host to guest', () => {
    const { host, guest } = pair()
    const audio = host.project.tracks.find((track) => track.type === 'audio')!
    const midi = host.project.tracks.find((track) => track.type === 'midi')!
    host.renameProject('Remote')
    host.setTempo(97)
    host.updateTrack(audio.id, { volume: 0.2, solo: true })
    host.addPlugin(audio.id, 'compressor')
    const plugin = host.track(audio.id)!.plugins.at(-1)!
    host.updatePlugin(audio.id, plugin.id, { wet: 0.5 })
    host.setScale({ root: 2, scale: 'mixolydian' })
    host.addMidiClip(midi.id, 1)
    const clipId = host.selectedMidiClipId!
    host.addNote(midi.id, clipId, { pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 0.7 })
    const channel = selectBeats(host).pattern!.channels[1]
    host.setStep(channel.id, 2, true)
    host.setMasterVolume(0.55)

    deliver(host, guest)

    expect(selectTransport(guest).tempo).toBe(97)
    expect(selectArrange(guest).project.name).toBe('Remote')
    expect(selectMixer(guest).tracks.find((track) => track.id === audio.id)).toMatchObject({ volume: 0.2, solo: true })
    expect(selectSession(guest).tracks.find((track) => track.id === audio.id)?.solo).toBe(true)
    expect(selectPlugin(guest, audio.id, plugin.id)?.wet).toBe(0.5)
    expect(selectScale(guest).root).toBe(2)
    expect(selectScale(guest).scale).toBe('mixolydian')
    expect(selectPiano(guest).clip).toBeNull()
    guest.selectClip(midi.id, clipId, true)
    expect(selectPiano(guest).clip?.notes.map((note) => note.pitch)).toEqual([60])
    expect(selectBeats(guest).pattern!.channels[1].cells[2].on).toBe(true)
    expect(selectMaster(guest).volume).toBe(0.55)
    expect(host.sync.peek()).toEqual([])
  })

  it('merges concurrent edits by stamp and fills a gap in order', () => {
    const { host, guest } = pair()
    host.setTempo(100)
    guest.setTempo(140)
    const hostOps = host.sync.drain()
    const guestOps = guest.sync.drain()
    host.applyRemoteOps(guestOps)
    guest.applyRemoteOps(hostOps)
    expect(host.project.tempo).toBe(guest.project.tempo)

    host.setMasterVolume(0.7)
    host.setTempo(88)
    const batched = host.sync.drain()
    expect(batched.map((op) => op.p)).toEqual(['masterVolume', 'tempo'])
    const held = guest.project.tempo
    guest.applyRemoteOps([batched[1]])
    expect(guest.project.tempo).toBe(held)
    expect(guest.project.masterVolume).not.toBe(0.7)
    guest.applyRemoteOps([batched[0]])
    expect(guest.project.masterVolume).toBe(0.7)
    expect(guest.project.tempo).toBe(88)
  })

  it('checkpoints a new guest, then fills a later gap with ops', () => {
    const { host, guest } = pair()
    host.setTempo(91)
    host.updateTrack(host.project.tracks[0].id, { name: 'Lead' })
    host.sync.drain()
    const hello = guest.sync.hello(guest.project)
    const checkpoint = host.sync.replyTo(hello, host.project)
    expect(checkpoint.kind).toBe('checkpoint')
    guest.mergeRemoteCheckpoint(checkpoint.project!, checkpoint.stamps, 'remote', checkpoint.lamport, host.sync.actor, host.sync.seq)
    expect(guest.project.tempo).toBe(91)
    expect(selectMixer(guest).tracks[0].name).toBe('Lead')

    host.setMasterVolume(0.42)
    const missed = host.sync.drain()
    expect(missed.map((op) => op.p)).toEqual(['masterVolume'])
    const again = guest.sync.hello(guest.project)
    const reply = host.sync.replyTo(again, host.project)
    expect(reply.kind).toBe('ops')
    guest.applyRemoteOps(reply.ops)
    expect(selectMaster(guest).volume).toBe(0.42)

    const stale = guest.sync.hello(guest.project)
    stale.seen[host.sync.actor] = host.sync.seq
    stale.digest = 'stale'
    expect(host.sync.replyTo(stale, host.project).kind).toBe('checkpoint')
  })

  it('keeps the journal across a refresh of the same project', () => {
    const store = new ProjectStore(createEmptyProject(48000, 'Keep'))
    store.setTempo(77)
    store.updateTrack(store.project.tracks[1].id, { pan: 0.4 })
    const seq = store.sync.seq
    const actor = store.sync.actor
    const saved = structuredClone(store.project) as Project
    const next = new ProjectStore(createEmptyProject())
    next.loadProject(saved, new Map())
    expect(next.project.tempo).toBe(77)
    expect(selectMixer(next).tracks[1].pan).toBe(0.4)
    expect(next.sync.seq).toBe(seq)
    expect(next.sync.actor).toBe(actor)
    next.setMasterVolume(0.2)
    expect(next.sync.peek()[0]?.s).toBe(seq + 1)
  })

  it('refuses audio payloads on the sync socket', () => {
    expect(containsAudio({ wav: 'AAAA' })).toBe(true)
    expect(containsAudio({ channels: [new Array(10).fill(0)] })).toBe(true)
    expect(syncMessageOk({ t: 'sync-ops', ops: [{ a: 'a', s: 1, l: 1, p: 'tempo', v: { channels: [1, 2, 3] } }] })).toBe(false)
    expect(syncMessageOk({ t: 'sync-ops', ops: [{ a: 'a', s: 1, l: 1, p: 'tempo', v: 120 }] })).toBe(true)
    expect(syncMessageOk({ t: 'sync-hello', actor: 'a', seq: 1, lamport: 1, digest: 'ab', seen: {} })).toBe(true)
  })
})
