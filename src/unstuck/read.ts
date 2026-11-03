/** Read a selected MIDI clip so Continue, Variation, and Add a part can follow it. */

import type { Project, Track } from '../model/types'
import { roleLabel, type RoleId } from './brief'
import type { ClipPicture, DraftNote } from './draft'

const DRUMS = new Set([35, 36, 37, 38, 39, 40, 41, 42, 44, 45, 46, 47, 48, 49, 50, 51, 54, 56, 62, 63, 64, 75])

export function readClip(project: Project, clipId: string | null | undefined, barBeats: number): ClipPicture | null {
  if (!clipId) return null
  for (const track of project.tracks) {
    const clip = track.midiClips.find((item) => item.id === clipId && !item.slotOnly)
    if (!clip || !clip.notes.length) continue
    const notes: DraftNote[] = clip.notes
      .filter((note) => !note.muted)
      .map((note) => ({
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        velocity: note.velocity,
        ...(note.fine ? { fine: note.fine } : {}),
        ...(note.slide ? { slide: true } : {}),
      }))
      .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
    if (!notes.length) continue
    const bars = Math.max(1, Math.round(clip.durationBeats / Math.max(0.5, barBeats)))
    const register = notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length
    return {
      trackId: track.id,
      clipId: clip.id,
      name: clip.name,
      role: detectRole(track, notes),
      startBeat: clip.startBeat,
      durationBeats: clip.durationBeats,
      bars,
      notes,
      register,
      density: notes.length / Math.max(0.25, clip.durationBeats),
      key: dominantPitchClass(notes),
    }
  }
  return null
}

export function complementRole(role: ClipPicture['role']): RoleId {
  if (role === 'chords') return 'bass'
  if (role === 'melody') return 'chords'
  if (role === 'pad' || role === 'arp') return 'chords'
  if (role === 'bass') return 'drums'
  if (role === 'drums') return 'bass'
  return 'drums'
}

export function complementLabel(role: ClipPicture['role']) {
  return `Add ${roleLabel(complementRole(role)).toLowerCase()}`
}

function detectRole(track: Track, notes: DraftNote[]): ClipPicture['role'] {
  const name = track.name.toLowerCase()
  if (track.instrument === 'pads' || track.instrument === 'drum-machine' || name.includes('drum')) return 'drums'
  if (track.instrument === '808' || name.includes('bass')) return 'bass'
  if (name.includes('melody') || name.includes('lead')) return 'melody'
  if (name.includes('pad')) return 'pad'
  if (name.includes('arp')) return 'arp'
  const drumRatio = notes.filter((note) => DRUMS.has(note.pitch)).length / notes.length
  if (drumRatio > 0.65) return 'drums'
  if (name.includes('chord') || track.instrument === 'scaler') return 'chords'
  const groups = cluster(notes)
  const poly = groups.reduce((sum, group) => sum + group.length, 0) / Math.max(1, groups.length)
  if (poly >= 1.8) return 'chords'
  const mean = notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length
  if (mean < 52) return 'bass'
  return 'melody'
}

function cluster(notes: DraftNote[]) {
  const groups: DraftNote[][] = []
  for (const note of notes) {
    const last = groups[groups.length - 1]
    if (!last || note.startBeat - last[0].startBeat > 0.08) groups.push([note])
    else last.push(note)
  }
  return groups
}

function dominantPitchClass(notes: DraftNote[]) {
  const tally = new Array<number>(12).fill(0)
  for (const note of notes) tally[((note.pitch % 12) + 12) % 12] += Math.max(0.1, note.durationBeats)
  let best = 0
  for (let i = 1; i < 12; i++) if (tally[i] > tally[best]) best = i
  return best
}
