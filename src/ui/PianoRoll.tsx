import { useEffect, useRef, useState } from 'react'
import type { ProjectStore } from '../state/store'

export function PianoRoll({ store }: { store: ProjectStore }) {
  const track = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
  const clip = track?.midiClips.find((item) => item.id === store.selectedMidiClipId)
  const [row, setRow] = useState(16)
  const rowRef = useRef(row)
  rowRef.current = row
  const rollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rollRef.current
    if (!el) return
    let startDist = 0
    let startRow = rowRef.current
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const start = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        startDist = distance(event.touches)
        startRow = rowRef.current
      }
    }
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !startDist) return
      event.preventDefault()
      setRow(Math.min(44, Math.max(12, startRow * (distance(event.touches) / startDist))))
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
    }
  }, [clip?.id])
  if (!track || !clip) return null
  const low = 48
  const high = 84
  const pxBeat = 70
  const width = Math.max(clip.durationBeats, 8) * pxBeat
  return (
    <div className="piano">
      <div className="keys">
        {Array.from({ length: high - low + 1 }, (_, index) => {
          const pitch = high - index
          const black = [1, 3, 6, 8, 10].includes(pitch % 12)
          return (
            <div key={pitch} className={`key ${black ? 'black' : ''}`} style={{ height: row }}>
              {pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}
            </div>
          )
        })}
      </div>
      <div
        className="roll" ref={rollRef}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          const beat = Math.floor((event.clientX - bounds.left) / (pxBeat / 4)) / 4
          const pitch = high - Math.floor((event.clientY - bounds.top) / row)
          store.addNote(track.id, clip.id, { pitch, startBeat: Math.max(0, beat), durationBeats: 1, velocity: 0.8 })
        }}
      >
        <div style={{ width, height: (high - low + 1) * row, position: 'relative' }}>
          {clip.notes.map((note) => (
            <div
              key={note.id}
              className={`note ${store.selectedNoteId === note.id ? 'selected' : ''}`}
              style={{ left: note.startBeat * pxBeat, width: Math.max(8, note.durationBeats * pxBeat), top: (high - note.pitch) * row, height: Math.max(12, row - 2) }}
              onClick={(event) => {
                event.stopPropagation()
                store.selectNote(note.id)
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
                const originX = event.clientX
                const originBeat = note.startBeat
                let next = originBeat
                const move = (ev: PointerEvent) => {
                  next = Math.max(0, Math.round((originBeat + (ev.clientX - originX) / pxBeat) * 4) / 4)
                  const node = event.currentTarget as HTMLDivElement
                  node.style.left = `${next * pxBeat}px`
                }
                const up = () => {
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', up)
                  store.updateNote(track.id, clip.id, note.id, { startBeat: next })
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
