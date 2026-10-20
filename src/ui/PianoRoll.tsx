import type { ProjectStore } from '../state/store'

export function PianoRoll({ store }: { store: ProjectStore }) {
  const track = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
  const clip = track?.midiClips.find((item) => item.id === store.selectedMidiClipId)
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
            <div key={pitch} className={`key ${black ? 'black' : ''}`}>
              {pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}
            </div>
          )
        })}
      </div>
      <div
        className="roll"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          const beat = Math.floor((event.clientX - bounds.left) / (pxBeat / 4)) / 4
          const pitch = high - Math.floor((event.clientY - bounds.top) / 16)
          store.addNote(track.id, clip.id, { pitch, startBeat: Math.max(0, beat), durationBeats: 1, velocity: 0.8 })
        }}
      >
        <div style={{ width, height: (high - low + 1) * 16, position: 'relative' }}>
          {clip.notes.map((note) => (
            <div
              key={note.id}
              className={`note ${store.selectedNoteId === note.id ? 'selected' : ''}`}
              style={{ left: note.startBeat * pxBeat, width: Math.max(8, note.durationBeats * pxBeat), top: (high - note.pitch) * 16 }}
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
