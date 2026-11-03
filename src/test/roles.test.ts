import { describe, expect, it } from 'vitest'
import {
  accessForInvite,
  ACCESS_COPY,
  collabAccessFor,
  isCommentOp,
  isTimelineComment,
  locksProject,
  mayComment,
  mayRelayAwareness,
  mayWriteProject,
  opsAllowed,
  parseCollabAccess,
  readInviteToken,
  relayProjectTraffic,
  roleShareUrl,
  sanitizeTimelineComment,
  type CollabAccess,
} from '../state/ops'

const tempo = { a: 'guest', s: 1, l: 1, p: 'tempo', v: 100 }
const marker = { a: 'guest', s: 2, l: 2, p: 'comments/c1', v: { text: 'chorus', beat: 16 } }

describe('collab roles', () => {
  it('reads View, Comment, and Edit, and treats the host as Edit', () => {
    expect(parseCollabAccess('view')).toBe('view')
    expect(parseCollabAccess('Comment')).toBe('comment')
    expect(parseCollabAccess('full')).toBe('edit')
    expect(parseCollabAccess('host')).toBeNull()
    expect(collabAccessFor('host', 'view')).toBe('edit')
    expect(collabAccessFor('guest', undefined)).toBe('view')
    expect(collabAccessFor('guest', 'comment')).toBe('comment')
    expect(ACCESS_COPY.view.label).toBe('View')
    expect(ACCESS_COPY.comment.label).toBe('Comment')
    expect(ACCESS_COPY.edit.label).toBe('Edit')
  })

  it('lets a share token choose the role and falls back to View', () => {
    const invites = new Map<string, CollabAccess>([['tokcomment', 'comment'], ['tokedit', 'edit']])
    expect(accessForInvite(invites, 'tokcomment')).toBe('comment')
    expect(accessForInvite(invites, 'tokedit')).toBe('edit')
    expect(accessForInvite(invites, 'missing')).toBe('view')
    expect(accessForInvite({ tokview: 'view' }, 'tokview')).toBe('view')
    const url = roleShareUrl('https://cueharbor.app/', 'ab12cd', 'tokcomment', 'comment')
    expect(url).toBe('https://cueharbor.app/?session=AB12CD&invite=tokcomment&role=comment')
    expect(readInviteToken(url)).toBe('tokcomment')
    expect(readInviteToken('?session=AB12CD')).toBe('')
  })

  it('rejects project ops from View and Comment, and allows comment paths for Comment', () => {
    expect(mayWriteProject('view')).toBe(false)
    expect(mayWriteProject('comment')).toBe(false)
    expect(mayWriteProject('edit')).toBe(true)
    expect(mayComment('view')).toBe(false)
    expect(mayComment('comment')).toBe(true)
    expect(mayComment('edit')).toBe(true)
    expect(isCommentOp(marker)).toBe(true)
    expect(isCommentOp(tempo)).toBe(false)
    expect(opsAllowed('view', [tempo])).toBe(false)
    expect(opsAllowed('view', [marker])).toBe(false)
    expect(opsAllowed('comment', [tempo])).toBe(false)
    expect(opsAllowed('comment', [marker, tempo])).toBe(false)
    expect(opsAllowed('comment', [marker])).toBe(true)
    expect(opsAllowed('edit', [tempo, marker])).toBe(true)
    expect(relayProjectTraffic('view', 'sync-ops', [tempo])).toBe(false)
    expect(relayProjectTraffic('comment', 'sync-ops', [tempo])).toBe(false)
    expect(relayProjectTraffic('comment', 'sync-checkpoint')).toBe(false)
    expect(relayProjectTraffic('comment', 'project')).toBe(false)
    expect(relayProjectTraffic('view', 'comment')).toBe(false)
    expect(relayProjectTraffic('comment', 'comment')).toBe(true)
    expect(relayProjectTraffic('edit', 'sync-ops', [tempo])).toBe(true)
    expect(relayProjectTraffic('edit', 'project-asset')).toBe(true)
    expect(relayProjectTraffic('view', 'asset-index')).toBe(false)
    expect(relayProjectTraffic('comment', 'asset-index')).toBe(false)
    expect(relayProjectTraffic('edit', 'asset-index')).toBe(true)
    expect(relayProjectTraffic('view', 'sync-hello')).toBe(true)
    expect(relayProjectTraffic('view', 'aware')).toBe(false)
    expect(mayRelayAwareness('view')).toBe(true)
    expect(mayRelayAwareness('comment')).toBe(true)
    expect(mayRelayAwareness('edit')).toBe(true)
    expect(locksProject('guest', 'view')).toBe(true)
    expect(locksProject('guest', 'comment')).toBe(true)
    expect(locksProject('guest', 'edit')).toBe(false)
    expect(locksProject('host', 'view')).toBe(false)
  })

  it('keeps a short timeline comment and drops an empty one', () => {
    const comment = sanitizeTimelineComment({ text: '  tight snare  ', beat: 4.25, from: 'p1', name: 'Ada' })
    expect(comment).toMatchObject({ text: 'tight snare', beat: 4.25, from: 'p1', name: 'Ada' })
    expect(isTimelineComment(comment)).toBe(true)
    expect(sanitizeTimelineComment({ text: '   ', beat: 1, from: 'p1', name: 'Ada' })).toBeNull()
    expect(sanitizeTimelineComment({ text: 'late', beat: -1, from: 'p1', name: 'Ada' })).toBeNull()
    expect(sanitizeTimelineComment({ text: 'x'.repeat(400), beat: 2, from: 'p1', name: 'Ada' })?.text).toHaveLength(240)
  })
})
