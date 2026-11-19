import type { ReactNode } from 'react'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { tempoFollowsProject } from '../model/clipTempo'
import { hasStepSequencer } from '../model/editorOpen'
import { showsOnscreenPiano } from '../model/onscreenPiano'
import type { Track } from '../model/types'
import type { AudioEngine } from '../audio/engine'
import type { ProjectStore } from '../state/store'
import { OPEN_BEAT_MACHINE, showsOpenBeatMachine } from '../instruments/pads/identity'
import { KeyboardToggle } from './keyboardChrome'

interface SquareItem {
  key: string
  label: string
  mark: string
  word?: string
  title: string
  pressed?: boolean
  className?: string
  node?: 'keys' | 'button'
}

function follows(track: Track) {
  if (track.loopFollow === false) return false
  const clips = track.clips.filter((clip) => clip.playback !== 'recorded' && !clip.slotOnly)
  if (!clips.length) return true
  return clips.some((clip) => tempoFollowsProject(clip.stretch))
}

export function TrackSquare({
  store,
  engine,
  track,
  onOpenPiano,
  onOpenBeat,
  onOpenSteps,
  onOpenTrack,
  beatButton,
}: {
  store: ProjectStore
  engine: AudioEngine
  track: Track
  onOpenPiano: (trackId: string) => void
  onOpenBeat?: (trackId: string) => void
  onOpenSteps?: (trackId: string) => void
  onOpenTrack: (trackId: string) => void
  beatButton?: ReactNode
}) {
  const vocal = track.type === 'audio' && track.kind !== 'loop'
  const loop = track.type === 'audio' && track.kind === 'loop'
  const beat = showsOpenBeatMachine(track)
  const steps = !beat && hasStepSequencer(track)
  const piano = !beat && !steps && showsOnscreenPiano(track) && store.selectedTrackId === track.id
  const armable = track.type === 'midi' ? hardwareMidiAllowed(typeof navigator === 'undefined' ? '' : navigator.userAgent) : vocal
  const items: SquareItem[] = [
    {
      key: 'mute',
      label: track.mute ? 'Unmute track' : 'Mute track',
      mark: 'M',
      word: 'Mute',
      title: 'Mute this track. Linked tracks mute together.',
      pressed: track.mute,
      className: `mini${track.mute ? ' on-m' : ''}`,
    },
    {
      key: 'solo',
      label: track.solo ? 'Unsolo track' : 'Solo track',
      mark: 'S',
      word: 'Solo',
      title: 'Solo this track and keep its path to the master open.',
      pressed: track.solo,
      className: `mini${track.solo ? ' on-s' : ''}`,
    },
  ]
  if (beat) {
    items.push({
      key: 'beat',
      label: OPEN_BEAT_MACHINE,
      mark: 'Pad',
      title: OPEN_BEAT_MACHINE,
      className: 'beat-open',
    })
  } else if (steps) {
    items.push({
      key: 'steps',
      label: 'Step Sequencer',
      mark: 'St',
      title: 'Open the step sequencer.',
    })
  } else if (armable) {
    items.push({
      key: 'arm',
      label: track.armed ? 'Disarm track' : 'Arm track. This track records when you press record.',
      mark: 'R',
      word: 'Arm',
      title: track.type === 'midi' ? 'Record this instrument from its MIDI input.' : 'Arm this track. Only a vocal track records the mic.',
      pressed: track.armed,
      className: `mini${track.armed ? ' on-r' : ''}`,
    })
  }
  if (items.length < 4 && piano) {
    items.push({ key: 'keys', label: 'Keys', mark: 'Keys', title: 'Show the on-screen piano.', node: 'keys' })
  }
  if (items.length < 4 && track.type === 'midi') {
    items.push({
      key: 'roll',
      label: 'Piano roll',
      mark: 'Roll',
      title: 'Piano roll. Double-tap a MIDI clip to open it too.',
      className: 'piano-open',
    })
  }
  if (items.length < 4 && vocal) {
    items.push({
      key: 'monitor',
      label: track.monitor ? 'Stop input monitor' : 'Input monitor',
      mark: 'In',
      title: 'Hear the mic on this track while it is armed. The input meter and gain sit on the lane.',
      pressed: track.monitor,
      className: track.monitor ? 'on' : '',
    })
  }
  if (items.length < 4 && loop) {
    const on = follows(track)
    items.push({
      key: 'follow',
      label: on ? 'Stop tempo follow' : 'Tempo follow',
      mark: 'F',
      title: on ? 'Loops on this track follow the song. Tap to keep their file tempo.' : 'Loops on this track keep their file tempo. Tap to follow the song.',
      pressed: on,
      className: on ? 'on' : '',
    })
  }
  if (items.length < 4) {
    items.push({
      key: 'track',
      label: 'Track',
      mark: '⋯',
      title: 'Input, routing, inserts, and the rest of this track.',
      className: 'mini track-more',
    })
  }
  const shown = items.slice(0, 4)

  function press(item: SquareItem) {
    if (item.key === 'mute') store.toggleTrack(track.id, 'mute')
    else if (item.key === 'solo') store.toggleTrack(track.id, 'solo')
    else if (item.key === 'arm') store.updateTrack(track.id, { armed: !track.armed })
    else if (item.key === 'beat') {
      if (onOpenBeat) onOpenBeat(track.id)
      else store.insertPads(track.id)
    } else if (item.key === 'steps') onOpenSteps?.(track.id)
    else if (item.key === 'roll') onOpenPiano(track.id)
    else if (item.key === 'monitor') store.updateTrack(track.id, { monitor: !track.monitor })
    else if (item.key === 'follow') {
      const next = !follows(track)
      store.updateTrack(track.id, { loopFollow: next })
      for (const clip of track.clips) {
        if (clip.playback === 'recorded') continue
        if (next) store.setClipStretch(track.id, clip.id, { tempoMode: 'follow', followTempo: true, sourceBpm: clip.stretch?.sourceBpm || store.project.tempo })
        else store.setClipStretch(track.id, clip.id, { followTempo: false })
      }
    } else onOpenTrack(track.id)
  }

  return (
    <div className="track-square" data-track-controls="" data-audio-kind={track.type === 'audio' ? track.kind || 'vocal' : undefined} role="group" aria-label={`${track.name} controls`}>
      {shown.map((item) => item.node === 'keys' ? (
        <KeyboardToggle key={item.key} store={store} engine={engine} word="Keys" />
      ) : item.key === 'beat' && beatButton ? (
        <span key={item.key} className="track-square-beat">{beatButton}</span>
      ) : (
        <button
          key={item.key}
          type="button"
          className={item.className}
          data-beat-machine={item.key === 'beat' ? track.id : undefined}
          data-piano={item.key === 'roll' ? track.id : undefined}
          data-open-roll={item.key === 'roll' ? track.id : undefined}
          aria-pressed={item.pressed || undefined}
          aria-label={item.label}
          title={item.title}
          onClick={(event) => { event.stopPropagation(); press(item) }}
        >
          <span className="mini-mark">{item.mark}</span>
          {item.word ? <span className="mini-word">{item.word}</span> : null}
        </button>
      ))}
    </div>
  )
}
