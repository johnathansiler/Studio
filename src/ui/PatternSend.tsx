import { useState } from 'react'
import { projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'

/** Send the current pattern to the song as MIDI, an instrument, or an Arrange clip. */
export function PatternSend({
  store,
  beat,
  phone,
}: {
  store: ProjectStore
  beat: number
  phone: boolean
}) {
  const tracks = store.project.tracks.filter((track) => track.type === 'midi')
  const [trackId, setTrackId] = useState('')
  const midi = phone ? 'MIDI' : 'To Song as MIDI'
  const inst = phone ? 'Inst' : 'To Instrument'
  const arrange = phone ? 'Arrange' : 'To Arrange'
  const unique = phone ? 'Unique' : 'Make unique'

  function send(mode: 'midi' | 'instrument') {
    store.sendPatternToSong(mode, trackId || null, beat)
  }

  return (
    <div className="pattern-send" role="group" aria-label="Send pattern">
      <select
        aria-label="Drum track. New kit creates one. Or pick a track that is already there."
        title="New kit creates a drum track. Or pick one that is already there."
        value={trackId}
        onChange={(event) => setTrackId(event.target.value)}
      >
        <option value="">New kit</option>
        {tracks.map((track) => (
          <option key={track.id} value={track.id}>{track.name}</option>
        ))}
      </select>
      <TipButton label={midi} hint="Turn this pattern into MIDI on a drum-kit track and open it in the piano roll." onClick={() => send('midi')} />
      <TipButton label={inst} hint="Put this pattern on a drum instrument that plays the same samples, as editable MIDI." onClick={() => send('instrument')} />
      <TipButton label={arrange} hint="Place this pattern on Arrange at the playhead. It stays linked to the step grid." onClick={() => store.placePattern(Math.max(0, beat), trackId || undefined)} />
      <TipButton
        label={unique}
        hint="Give the selected Arrange clip its own pattern. Other copies stay linked."
        disabled={!store.selectedPatternClipId}
        onClick={() => {
          if (store.selectedPatternClipId) store.makePatternClipUnique(store.selectedPatternClipId)
        }}
      />
    </div>
  )
}

export function patternBeat(store: ProjectStore, sample: number) {
  return Math.max(0, projectSampleBeat(store.project, sample))
}
