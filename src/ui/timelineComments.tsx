import { useState } from 'react'
import { projectBeatSample, projectSampleBeat, pxAtBeat } from '../model/tempoMap'
import type { Project } from '../model/types'
import type { SessionClient } from '../remote/session'
import { mayComment } from '../state/ops'

/** Pins sit on the ruler. Comment and Edit can drop one at the playhead. */
export function CommentPins({
  session,
  project,
  px,
  onSeek,
}: {
  session: SessionClient
  project: Project
  px: number
  onSeek: (sample: number) => void
}) {
  const comments = session.state.comments ?? []
  return (
    <>
      {comments.map((comment) => (
        <button
          key={comment.id}
          type="button"
          className="tl-pin"
          style={{ left: pxAtBeat(project, comment.beat, px) }}
          aria-label={`${comment.name} comment. ${comment.text}`}
          title={`${comment.name}: ${comment.text}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onSeek(projectBeatSample(project, comment.beat))
          }}
        >
          {comment.text}
        </button>
      ))}
    </>
  )
}

export function CommentControl({ session, project, position }: { session: SessionClient; project: Project; position: number }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  if (session.state.status !== 'live' || !mayComment(session.selfAccess())) return null
  return (
    <>
      <button type="button" className="text-btn comment-open" onPointerDown={(event) => event.stopPropagation()} onClick={() => setOpen((value) => !value)}>
        Comment
      </button>
      {open && (
        <form
          className="comment-pop"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault()
            const note = text.trim()
            if (!note) return
            session.sendComment(note, Math.max(0, projectSampleBeat(project, position)))
            setText('')
            setOpen(false)
          }}
        >
          <input aria-label="Timeline comment" value={text} placeholder="Note at the playhead" onChange={(event) => setText(event.target.value)} />
          <button type="submit" className="text-btn">
            Add
          </button>
          <button type="button" className="text-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      )}
    </>
  )
}
