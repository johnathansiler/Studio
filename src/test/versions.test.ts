import { describe, expect, it } from 'vitest'
import { canRebuildRoom } from '../model/negotiate'
import { createEmptyProject } from '../model/types'
import { adoptSavedRoom, claimFromHello, digestProject, musicalClone, pickRoomClaim } from '../state/ops'
import { ProjectStore } from '../state/store'
import { expiredVersionIds, shouldSaveVersion, VERSION_INTERVAL_MS, versionTitle, versionWhen } from '../state/versions'
import { buildRoomCopy } from '../storage/idb'

describe('room copies', () => {
  it('prefers the host copy, then the newest participant', () => {
    const host = { role: 'host' as const, savedAt: 10, lamport: 1, actor: 'host', digest: 'h' }
    const guest = { role: 'guest' as const, savedAt: 5000, lamport: 9, actor: 'guest', digest: 'g' }
    expect(pickRoomClaim([guest, host])?.actor).toBe('host')
    const older = { role: 'guest' as const, savedAt: 10, lamport: 8, actor: 'older', digest: 'o' }
    const newer = { role: 'guest' as const, savedAt: 11, lamport: 2, actor: 'newer', digest: 'n' }
    expect(pickRoomClaim([older, newer])?.actor).toBe('newer')
    expect(pickRoomClaim([])).toBeNull()
  })

  it('loads a saved room only when this tab has nothing newer', () => {
    expect(adoptSavedRoom({ openDigest: 'a', openLamport: 0, openUntouched: true, savedDigest: 'b', savedLamport: 1 })).toBe(true)
    expect(adoptSavedRoom({ openDigest: 'a', openLamport: 4, openUntouched: false, savedDigest: 'b', savedLamport: 3 })).toBe(false)
    expect(adoptSavedRoom({ openDigest: 'a', openLamport: 1, openUntouched: false, savedDigest: 'a', savedLamport: 9 })).toBe(false)
  })

  it('keeps the snapshot and the op log without waveforms', () => {
    const store = new ProjectStore(createEmptyProject(48000, 'Room'))
    store.setTempo(128)
    store.project.waveforms = { take: [{ min: 0, max: 1 }] }
    const copy = buildRoomCopy({
      code: 'eevedr',
      role: 'host',
      name: 'Ada',
      savedAt: 50,
      project: store.project,
      journal: store.sync.snapshot(),
    })
    expect(copy.code).toBe('EEVEDR')
    expect(copy.project.waveforms).toBeUndefined()
    expect(copy.project.tempo).toBe(128)
    expect(copy.digest).toBe(digestProject(copy.project))
    expect(copy.seq).toBe(store.sync.seq)
    expect(copy.log.at(-1)?.p).toBe('tempo')
    expect(copy.actor).toBe(store.sync.actor)
  })

  it('rejoins from the saved journal and answers hello with that digest', () => {
    const host = new ProjectStore(createEmptyProject(48000, 'Room'))
    host.setTempo(133)
    const copy = buildRoomCopy({
      code: 'EEVEDR',
      role: 'host',
      name: 'Ada',
      savedAt: 80,
      project: host.project,
      journal: host.sync.snapshot(),
    })
    const restarted = new ProjectStore(createEmptyProject())
    restarted.replaceWithRoom(copy.project, new Map(), {
      projectId: copy.projectId,
      actor: copy.actor,
      seq: copy.seq,
      lamport: copy.lamport,
      log: copy.log,
      stamps: copy.stamps,
      seen: copy.seen,
      trimmed: copy.trimmed,
    })
    const guest = new ProjectStore(createEmptyProject())
    const hello = guest.sync.hello(guest.project)
    const reply = restarted.sync.replyTo(hello, restarted.project)
    expect(reply.kind).toBe('checkpoint')
    expect(reply.digest).toBe(digestProject(restarted.project))
    expect(reply.project?.tempo).toBe(133)
    const hostClaim = claimFromHello({ ...restarted.sync.hello(restarted.project), savedAt: copy.savedAt, role: 'host' }, 'host')
    const guestClaim = claimFromHello({ ...hello, savedAt: 9_000, role: 'guest' }, 'guest')
    expect(pickRoomClaim([guestClaim, hostClaim])?.digest).toBe(hostClaim.digest)
    guest.adoptSharedRoom(reply.project!, reply.stamps, reply.lamport || 0, restarted.sync.actor, restarted.sync.seq)
    expect(digestProject(guest.project)).toBe(digestProject(restarted.project))
    expect(guest.sync.hello(guest.project).digest).toBe(reply.digest)
  })

  it('rebuilds a dead room code in memory and refuses a live or malformed one', () => {
    expect(canRebuildRoom('EEVEDR', false, true)).toBe(true)
    expect(canRebuildRoom('EEVEDR', true, true)).toBe(false)
    expect(canRebuildRoom('EEVEDR', false, false)).toBe(false)
    expect(canRebuildRoom('BAD', false, true)).toBe(false)
    expect(canRebuildRoom('OTHER1', false, true)).toBe(false)
  })
})

describe('named versions', () => {
  it('names a save and waits between automatic copies', () => {
    expect(versionTitle('record', Date.UTC(2026, 10, 3, 19, 5))).toMatch(/^Recording /)
    expect(versionTitle('timer', Date.UTC(2026, 10, 3, 19, 5))).toMatch(/^Auto /)
    expect(versionTitle('manual', Date.UTC(2026, 10, 3, 19, 5))).toMatch(/^Version /)
    expect(versionWhen(Date.UTC(2026, 10, 3, 19, 5))).toMatch(/^\d{2}:\d{2}$/)
    expect(shouldSaveVersion({ reason: 'manual', lastAt: 10, now: 11, digest: 'a', lastDigest: 'a' })).toBe(true)
    expect(shouldSaveVersion({ reason: 'record', lastAt: 10, now: 11, digest: 'b', lastDigest: 'a' })).toBe(true)
    expect(shouldSaveVersion({ reason: 'record', lastAt: 10, now: 11, digest: 'a', lastDigest: 'a' })).toBe(false)
    expect(shouldSaveVersion({ reason: 'timer', lastAt: 0, now: 60_000, digest: 'b', lastDigest: 'a' })).toBe(false)
    expect(shouldSaveVersion({ reason: 'timer', lastAt: 0, now: VERSION_INTERVAL_MS, digest: 'b', lastDigest: 'a' })).toBe(true)
    expect(shouldSaveVersion({ reason: 'timer', lastAt: null, now: 1, digest: 'b', lastDigest: null })).toBe(true)
    expect(expiredVersionIds([{ id: 'a', at: 1 }, { id: 'b', at: 3 }, { id: 'c', at: 2 }], 2)).toEqual(['a'])
  })

  it('restores a version as ops for everyone and keeps undo on the restoring device', () => {
    const host = new ProjectStore(createEmptyProject(48000, 'Versions'))
    const guest = new ProjectStore(musicalClone(host.project))
    host.setTempo(100)
    const saved = musicalClone(host.project)
    guest.applyRemoteOps(host.sync.drain())
    expect(guest.project.tempo).toBe(100)
    host.setTempo(160)
    guest.applyRemoteOps(host.sync.drain())
    expect(guest.project.tempo).toBe(160)
    expect(guest.canUndo).toBe(false)

    host.restoreForEveryone(saved)
    const restoreOps = host.sync.drain()
    expect(restoreOps.map((op) => op.p)).toContain('tempo')
    guest.applyRemoteOps(restoreOps)
    expect(guest.project.tempo).toBe(100)
    expect(guest.canUndo).toBe(false)
    expect(host.canUndo).toBe(true)

    host.undo()
    expect(host.project.tempo).toBe(160)
    guest.applyRemoteOps(host.sync.drain())
    expect(guest.project.tempo).toBe(160)
    expect(guest.canUndo).toBe(false)
  })

  it('lets an Edit guest restore and undo, and keeps View from restoring', () => {
    const host = new ProjectStore(createEmptyProject(48000, 'Guest restore'))
    host.setTempo(110)
    const saved = musicalClone(host.project)
    host.setTempo(140)
    const view = new ProjectStore(musicalClone(host.project))
    view.remoteFollow = true
    view.restoreForEveryone(saved)
    expect(view.project.tempo).toBe(140)
    expect(view.canUndo).toBe(false)

    const editor = new ProjectStore(musicalClone(host.project))
    editor.restoreForEveryone(saved)
    expect(editor.project.tempo).toBe(110)
    expect(editor.canUndo).toBe(true)
    editor.undo()
    expect(editor.project.tempo).toBe(140)
    expect(editor.sync.peek().some((op) => op.p === 'tempo')).toBe(true)
  })
})
