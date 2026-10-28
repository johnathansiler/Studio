import { layoutScore, scoreSvg } from '../model/score'
import { NOTE_NAMES, scaleById } from '../model/scale'
import { SCORE_DURATIONS } from '../model/stepEntry'
import { selectMidiEditor } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'

export function ScoreView({ store }: { store: ProjectStore }) {
  const { track, clip, editor, project, scale } = selectMidiEditor(store)
  if (!track || !clip) return <p className="me-empty">Open a MIDI clip to see the score.</p>
  const layout = layoutScore(clip.notes, project.timeSignature, scale.root, scale.scale, clip.durationBeats, editor.scorePage)
  const svg = scoreSvg(layout)
  const selected = clip.notes.find((note) => note.id === store.selectedNoteId)
  const key = `${NOTE_NAMES[((scale.root % 12) + 12) % 12]} ${scaleById(scale.scale).name}`
  const time = `${project.timeSignature.numerator}/${project.timeSignature.denominator}`
  return (
    <div className="me-score" id="score-print">
      <div className="me-bar">
        <span className="me-place" title="Key signature from the project key and scale.">{key}</span>
        <span className="me-place" title="Time signature from the project.">{time}</span>
        <TipButton label="‹" hint="Previous four bars." disabled={layout.page <= 0} onClick={() => store.setMidiEditor({ scorePage: layout.page - 1 })} />
        <TipButton label="›" hint="Next four bars." disabled={layout.page >= layout.pages - 1} onClick={() => store.setMidiEditor({ scorePage: layout.page + 1 })} />
        <select
          aria-label="Note length. How long the selected note is. New notes use this length too."
          title="How long the selected note is. New notes use this length too."
          value={String(SCORE_DURATIONS.reduce((best, item) => (Math.abs(item.beats - editor.scoreDuration) < Math.abs(best.beats - editor.scoreDuration) ? item : best)).beats)}
          onChange={(event) => {
            const beats = Number(event.target.value)
            store.setMidiEditor({ scoreDuration: beats })
            if (selected) store.editScoreNote(track.id, clip.id, selected.id, { durationBeats: beats })
          }}
        >
          {SCORE_DURATIONS.map((item) => (
            <option key={item.id} value={item.beats}>{item.label}</option>
          ))}
        </select>
        {selected && (
          <>
            <TipButton label="−" hint="Lower the selected note by one semitone." onClick={() => store.editScoreNote(track.id, clip.id, selected.id, { pitch: selected.pitch - 1 })} />
            <TipButton label="+" hint="Raise the selected note by one semitone." onClick={() => store.editScoreNote(track.id, clip.id, selected.id, { pitch: selected.pitch + 1 })} />
            <TipButton label="Delete" hint="Remove the selected note." onClick={() => store.removeScoreNote(track.id, clip.id, selected.id)} />
          </>
        )}
        <TipButton label="Print" hint="Print this score, or save it as a PDF from the print dialog." onClick={printScore} />
      </div>
      <div
        className="me-staff"
        aria-label="Score. Tap a staff position to add a note. Tap a note to select it."
        onClick={(event) => {
          const cell = (event.target as Element).closest('[data-pitch]')
          if (!cell) return
          const noteId = cell.getAttribute('data-note')
          if (noteId) {
            store.selectNote(noteId)
            return
          }
          const beat = Number(cell.getAttribute('data-beat'))
          const pitch = Number(cell.getAttribute('data-pitch'))
          if (!Number.isFinite(beat) || !Number.isFinite(pitch)) return
          store.putScoreNote(track.id, clip.id, beat, pitch)
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  )
}

function printScore() {
  document.body.classList.add('printing-score')
  const done = () => {
    document.body.classList.remove('printing-score')
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  window.print()
}
