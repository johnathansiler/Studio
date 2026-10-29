import { makeTrack, TRACK_COLORS, type Track, type TrackInstrument } from './types'

export type AddKind = 'audio' | 'midi' | 'drum' | 'bus'

export interface AddTrackSpec {
  kind: AddKind
  count: number
  instrument: TrackInstrument
  input: 'mic' | 'line'
  /** 1–8. When set, the audio input is `mic:0` … `line:7`. Omitted keeps `input` as written. */
  inputIndex?: number
  channels: 1 | 2
  armed: boolean
}

export function audioInput(spec: AddTrackSpec): string {
  if (spec.kind !== 'audio') return 'none'
  if (spec.inputIndex == null) return spec.input
  const index = Math.min(8, Math.max(1, Math.round(spec.inputIndex))) - 1
  return `${spec.input}:${index}`
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
  if (spec.kind === 'drum') return spec.instrument === '808' ? '808' : 'Drum'
  if (spec.instrument === 'scaler') return 'Scaler'
  if (spec.instrument === 'pads') return 'Pads'
  if (spec.instrument === 'library') return 'Library'
  if (spec.instrument === 'sampler') return 'Sampler'
  if (spec.instrument === '808') return '808'
  if (spec.instrument === 'drum-machine') return 'Drums'
  if (spec.instrument === 'synth') return 'Synth'
  return 'Inst'
}

export function tracksFor(spec: AddTrackSpec, existing: Track[]): Track[] {
  const count = clampCount(spec.count)
  const name = label(spec)
  let used = existing.filter((track) => track.name === name || track.name.startsWith(`${name} `)).length
  const instrument: TrackInstrument = spec.kind === 'drum'
    ? (spec.instrument === '808' ? '808' : 'drum-machine')
    : spec.kind === 'midi' ? spec.instrument : 'none'
  const type = spec.kind === 'bus' ? 'bus' : spec.kind === 'audio' ? 'audio' : 'midi'
  const made: Track[] = []
  for (let i = 0; i < count; i++) {
    used += 1
    made.push(makeTrack({
      name: `${name} ${used}`,
      type,
      color: TRACK_COLORS[(existing.length + i) % TRACK_COLORS.length],
      instrument,
      input: audioInput(spec),
      channels: type === 'audio' ? spec.channels : 1,
      armed: type === 'audio' && spec.armed,
    }))
  }
  return made
}
