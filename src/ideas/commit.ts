/** Put a generated ensemble on the arrangement. One store mutate is one undo. */

import { projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import type { Project, Track } from '../model/types'
import { roleById } from '../unstuck/brief'
import type { SongDraft } from '../unstuck/draft'
import { applyUnstuckDraft } from '../unstuck/place'
import { partGenre } from './genres'
import type { Ensemble, PartRole } from './types'

const DRUMS = new Set(['pads', 'drum-machine'])
const KEPT = new Set(['library', 'sampler', 'pads', 'drum-machine', '808', 'scaler'])

/** Playhead, or the loop start when the loop is on, snapped to the bar. */
export function ensembleStartBeat(project: Project, playheadSample: number) {
  const bar = Math.max(1, quartersPerBar(project.timeSignature))
  const sample = project.loopEnabled ? project.loopStartSample : playheadSample
  const beat = Math.max(0, projectSampleBeat(project, Math.max(0, Number.isFinite(sample) ? sample : 0)))
  return Math.floor(beat / bar + 1e-6) * bar
}

export function placeEnsemble(project: Project, ensemble: Ensemble, playheadSample: number, selectedTrackId: string | null) {
  const start = ensembleStartBeat(project, playheadSample)
  const selected = selectedTrackId ? project.tracks.find((track) => track.id === selectedTrackId) : undefined
  const home = roleForTrack(selected, ensemble.parts.map((part) => part.role))
  const genre = partGenre(ensemble.genre)
  const tracks: SongDraft['tracks'] = []
  for (const part of ensemble.parts) {
    if (!part.notes.length) continue
    const meta = roleById(part.role)
    const onSelected = part.role === home && selected?.type === 'midi'
    const name = onSelected ? selected.name : namedTrack(project, part.role)
    const existing = project.tracks.find((track) => track.type === 'midi' && track.name === name)
    const bass808 = part.role === 'bass' && (genre.id === 'trap' || genre.id === 'drill')
    const instrument = part.role === 'drums' ? 'pads' : bass808 ? '808' : 'synth'
    const pluginId = part.role === 'drums' ? 'pads' : 'synth'
    tracks.push({
      role: part.role,
      name,
      color: meta.color,
      instrument,
      pluginId,
      mix: meta.mix,
      volume: meta.volume,
      pan: meta.pan,
      seed: ensemble.seed,
      leaveInstrument: Boolean(existing && KEPT.has(existing.instrument || '')),
      clips: [{
        name: part.name,
        startBeat: start,
        durationBeats: Math.max(ensemble.beatsPerBar, ensemble.bars * ensemble.beatsPerBar),
        ...(ensemble.clipSwing ? { swing: ensemble.clipSwing } : {}),
        notes: part.notes.map((note) => ({
          pitch: note.pitch,
          startBeat: note.startBeat,
          durationBeats: note.durationBeats,
          velocity: note.velocity,
          ...(note.fine ? { fine: note.fine } : {}),
          ...(note.slide ? { slide: true } : {}),
          ...(note.nudge ? { nudge: note.nudge } : {}),
        })),
      }],
    })
  }
  const draft: SongDraft = {
    summary: summaryOf(ensemble, start, tracks.length),
    seed: ensemble.seed,
    tempo: ensemble.tempo,
    key: ensemble.key,
    scaleId: ensemble.scaleId,
    sections: [],
    sectionMode: 'none',
    tracks,
  }
  const placed = applyUnstuckDraft(project, draft)
  return { ...placed, summary: draft.summary, start }
}

function summaryOf(ensemble: Ensemble, start: number, count: number) {
  const names = ensemble.parts.filter((part) => part.notes.length).map((part) => part.role).join(', ')
  const bar = Math.round(start / Math.max(1, ensemble.beatsPerBar)) + 1
  if (!count) return 'Pick a part to add.'
  return `Added ${partGenre(ensemble.genre).name} ${names} at bar ${bar}.`
}

function namedTrack(project: Project, role: PartRole) {
  if (role === 'chords') {
    const keys = project.tracks.find((track) => track.type === 'midi' && !isDrums(track) && /key|piano|chord/i.test(track.name))
    if (keys) return keys.name
  }
  if (role === 'bass') {
    const bass = project.tracks.find((track) => track.type === 'midi' && (track.instrument === '808' || /bass/i.test(track.name)))
    if (bass) return bass.name
  }
  if (role === 'drums') {
    const drums = project.tracks.find((track) => track.type === 'midi' && isDrums(track))
    if (drums) return drums.name
  }
  if (role === 'melody') {
    const lead = project.tracks.find((track) => track.type === 'midi' && /melody|lead/i.test(track.name))
    if (lead) return lead.name
  }
  return roleById(role).track
}

function isDrums(track: Track) {
  return DRUMS.has(track.instrument || '') || /drum/i.test(track.name)
}

function roleForTrack(track: Track | undefined, roles: PartRole[]): PartRole | null {
  if (!track || track.type !== 'midi') return null
  const name = track.name.toLowerCase()
  if (isDrums(track)) return roles.includes('drums') ? 'drums' : null
  if (track.instrument === '808' || name.includes('bass')) return roles.includes('bass') ? 'bass' : null
  if (name.includes('melody') || name.includes('lead')) return roles.includes('melody') ? 'melody' : null
  if (roles.includes('chords')) return 'chords'
  return roles.find((role) => role !== 'drums') ?? null
}
