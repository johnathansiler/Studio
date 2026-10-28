import { emptySampleProgram } from '../instruments/engine/program'
import { makeTrack, TRACK_COLORS, type Track, type TrackInstrument } from './types'

export type AddKind = 'audio' | 'midi' | 'drum' | 'bus'

export interface AddTrackSpec {
  kind: AddKind
  count: number
  instrument: TrackInstrument
  input: 'mic' | 'line'
  channels: 1 | 2
  armed: boolean
}

export const defaultAddSpec = (): AddTrackSpec => ({
  kind: 'audio',
  count: 1,
  instrument: 'synth',
  input: 'mic',
  channels: 1,
  armed: false,
})

export function clampCount(count: number) {
  if (!Number.isFinite(count)) return 1
  return Math.min(8, Math.max(1, Math.round(count)))
}

export function insertIndex(tracks: { id: string }[], selectedId: string | null) {
  const index = tracks.findIndex((track) => track.id === selectedId)
  return index < 0 ? tracks.length : index + 1
}

function label(spec: AddTrackSpec) {
  if (spec.kind === 'audio') return 'Audio'
  if (spec.kind === 'bus') return 'Bus'
  if (spec.kind === 'drum') return 'Drum'
  if (spec.instrument === 'sampler') return 'Sampler'
  if (spec.instrument === 'sample') return 'Sample'
  if (spec.instrument === '808') return '808'
  if (spec.instrument === 'drum-machine') return 'Drums'
  if (spec.instrument === 'synth') return 'Synth'
  return 'Inst'
}

export function tracksFor(spec: AddTrackSpec, existing: Track[]): Track[] {
  const count = clampCount(spec.count)
  const name = label(spec)
  let used = existing.filter((track) => track.name === name || track.name.startsWith(`${name} `)).length
  const instrument: TrackInstrument = spec.kind === 'drum' ? 'drum-machine' : spec.kind === 'midi' ? spec.instrument : 'none'
  const type = spec.kind === 'bus' ? 'bus' : spec.kind === 'audio' ? 'audio' : 'midi'
  const made: Track[] = []
  for (let i = 0; i < count; i++) {
    used += 1
    made.push(makeTrack({
      name: `${name} ${used}`,
      type,
      color: TRACK_COLORS[(existing.length + i) % TRACK_COLORS.length],
      instrument,
      input: type === 'audio' ? spec.input : 'none',
      channels: type === 'audio' ? spec.channels : 1,
      armed: type === 'audio' && spec.armed,
      sampleProgram: instrument === 'sample' ? emptySampleProgram() : undefined,
    }))
  }
  return made
}
