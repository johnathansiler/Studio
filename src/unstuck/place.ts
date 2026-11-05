/**
 * Write an Unstuck draft as ordinary project data: tracks, plugins, MIDI, markers.
 * One call is one undo step when the store wraps it.
 */

import { createPlugin } from '../audio/plugins/catalog'
import { isDrumsPlugin } from '../audio/plugins/ids'
import { chooseScale } from '../instruments/scaler/model'
import { normalizeScaler } from '../instruments/scaler/model'
import { normalizePadKit } from '../model/padMachine'
import { sectionKind } from '../model/sections'
import { normalizeScale } from '../model/scale'
import { stampMidiAtBeat } from '../model/playheadPlace'
import { makeTrack, uid, type MidiClip, type MidiNote, type Project, type Track } from '../model/types'
import { ensureScale, roleById, roleLabel, scaleIsBuiltin, type RoleId } from './brief'
import type { SongDraft } from './draft'

export const UNSTUCK_MARK = 'Ideas '
const CLIP_MARKS = ['Ideas ', 'Unstuck '] as const

const OURS = /^(Intro|Verse|Pre-Chorus|Pre|Post-Chorus|Chorus|Bridge|Instrumental|Outro|Loop|Breakdown|Break)( \d+)?$/

export function unstuckNamed(name: string) {
  return CLIP_MARKS.some((mark) => name.startsWith(mark))
}

export function nameHasRole(name: string, label: string) {
  return unstuckNamed(name) && name.includes(label)
}

export function applyUnstuckDraft(project: Project, draft: SongDraft): { trackId: string | null; clipId: string | null } {
  if (draft.tempo) project.tempo = draft.tempo
  if (draft.key != null && draft.scaleId) applyKey(project, draft.key, draft.scaleId)
  let trackId: string | null = null
  let clipId: string | null = null
  const labels = new Set((draft.replace?.roles ?? []).map((role) => roleLabel(role)))
  for (const spec of draft.tracks) {
    const track = ensureTrack(project, spec)
    if (draft.replace && labels.has(roleLabel(spec.role))) {
      exciseRole(track, roleLabel(spec.role), new Set(spec.clips.map((clip) => clip.name)), draft.replace.startBeat, draft.replace.endBeat)
    }
    for (const clip of spec.clips) {
      if (!clip.notes.length) continue
      const placed = pushClip(track, clip)
      trackId = track.id
      clipId = placed
    }
  }
  writeSections(project, draft)
  return { trackId, clipId }
}

export function arrangementEnd(project: Project) {
  let end = 0
  for (const track of project.tracks) {
    for (const clip of track.midiClips) {
      if (clip.slotOnly || clip.scene != null) continue
      end = Math.max(end, clip.startBeat + clip.durationBeats)
    }
  }
  return end
}

export function unstuckSpan(project: Project): { start: number; end: number } | null {
  let start = Infinity
  let end = 0
  for (const track of project.tracks) {
    for (const clip of track.midiClips) {
      if (clip.slotOnly || !unstuckNamed(clip.name)) continue
      start = Math.min(start, clip.startBeat)
      end = Math.max(end, clip.startBeat + clip.durationBeats)
    }
  }
  if (!Number.isFinite(start) || end <= start) return null
  return { start, end }
}

export function collectRole(project: Project, role: RoleId, start: number, end: number) {
  const label = roleLabel(role)
  const notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[] = []
  for (const track of project.tracks) {
    for (const clip of track.midiClips) {
      if (clip.slotOnly || !nameHasRole(clip.name, label)) continue
      for (const note of clip.notes) {
        const abs = clip.startBeat + note.startBeat
        if (abs < start - 1e-4 || abs >= end - 1e-4) continue
        notes.push({ pitch: note.pitch, startBeat: abs - start, durationBeats: note.durationBeats, velocity: note.velocity })
      }
    }
  }
  return notes
}

function applyKey(project: Project, key: number, scaleId: string) {
  const id = ensureScale(scaleId)
  const scale = normalizeScale(project.scale)
  if (scaleIsBuiltin(id)) {
    project.scale = { ...scale, root: key, scale: id, library: '' }
    return
  }
  const chosen = chooseScale(id)
  project.scale = { ...scale, root: key, scale: chosen.scale, library: id }
}

function ensureTrack(project: Project, spec: SongDraft['tracks'][number]) {
  const meta = roleById(spec.role)
  let track = project.tracks.find((item) => item.type === 'midi' && item.name === spec.name)
  const fresh = !track
  if (!track) {
    track = makeTrack({ name: spec.name, type: 'midi', color: spec.color, input: 'none', volume: spec.volume, pan: spec.pan })
    project.tracks.push(track)
  }
  claim(track, spec, fresh, meta.instrument)
  return track
}

function claim(track: Track, spec: SongDraft['tracks'][number], fresh: boolean, instrument: string) {
  const open = fresh || !track.instrument || track.instrument === 'none'
  if (instrument === 'pads' && (open || track.instrument === 'drum-machine' || track.instrument === 'pads')) {
    track.instrument = 'pads'
    track.padKit = normalizePadKit({ ...(track.padKit ?? {}), seed: spec.seed, swing: 50, name: spec.name })
  } else if (instrument === 'scaler' && (open || track.instrument === 'scaler' || track.instrument === 'synth')) {
    track.instrument = 'scaler'
    track.scaler = normalizeScaler({ ...(track.scaler ?? {}), ...spec.scaler })
  } else if (instrument === '808' && (open || track.instrument === 'synth' || track.instrument === '808')) {
    track.instrument = '808'
  } else if (open) {
    track.instrument = instrument === 'pads' || instrument === 'scaler' || instrument === '808' ? instrument : 'synth'
  }
  ensurePlugin(track, spec.pluginId)
  if (fresh && spec.mix) ensurePlugin(track, spec.mix)
  if (fresh) {
    track.volume = spec.volume
    track.pan = spec.pan
    track.color = spec.color
  }
}

function ensurePlugin(track: Track, pluginId: string) {
  if (pluginId === 'pads') {
    if (track.plugins.some((plugin) => isDrumsPlugin(plugin))) return
    track.plugins.push(createPlugin('pads'))
    return
  }
  if (track.plugins.some((plugin) => plugin.pluginId === pluginId)) return
  track.plugins.push(createPlugin(pluginId))
}

function pushClip(track: Track, clip: SongDraft['tracks'][number]['clips'][number]) {
  const notes: MidiNote[] = clip.notes.map((note) => ({
    id: uid('note'),
    pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
    startBeat: Math.max(0, note.startBeat),
    durationBeats: Math.max(0.05, note.durationBeats),
    velocity: Math.max(0.05, Math.min(1, note.velocity)),
    ...(note.fine ? { fine: Math.max(-100, Math.min(100, Math.round(note.fine))) } : {}),
    ...(note.slide ? { slide: true } : {}),
  }))
  const end = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0.25)
  const created: MidiClip = stampMidiAtBeat({
    id: uid('midi'),
    name: clip.name,
    startBeat: 0,
    durationBeats: Math.max(clip.durationBeats, end),
    notes,
  }, clip.startBeat)
  track.midiClips.push(created)
  return created.id
}

function owns(name: string, label: string, names: Set<string>) {
  if (names.has(name)) return true
  const prefixes = CLIP_MARKS.map((mark) => `${mark}${label}`)
  const replacingMain = [...names].some((item) => prefixes.some((prefix) => item.startsWith(prefix)))
  return replacingMain && prefixes.some((prefix) => name.startsWith(prefix))
}

function exciseRole(track: Track, label: string, names: Set<string>, start: number, end: number) {
  const next: MidiClip[] = []
  for (const clip of track.midiClips) {
    if (clip.slotOnly || !owns(clip.name, label, names)) {
      next.push(clip)
      continue
    }
    const clipEnd = clip.startBeat + clip.durationBeats
    if (clipEnd <= start + 1e-4 || clip.startBeat >= end - 1e-4) {
      next.push(clip)
      continue
    }
    const before = clip.notes.filter((note) => clip.startBeat + note.startBeat + note.durationBeats <= start + 1e-3)
    const after = clip.notes.filter((note) => clip.startBeat + note.startBeat >= end - 1e-4)
    if (before.length && clip.startBeat < start - 1e-4) {
      next.push({ ...clip, durationBeats: Math.max(0.25, start - clip.startBeat), notes: before })
    }
    if (after.length && clipEnd > end + 1e-4) {
      const shift = end - clip.startBeat
      next.push({
        ...clip,
        id: before.length ? uid('midi') : clip.id,
        name: clip.name,
        startBeat: end,
        durationBeats: Math.max(0.25, clipEnd - end),
        notes: after.map((note) => ({ ...note, id: uid('note'), startBeat: note.startBeat - shift })),
      })
    }
  }
  track.midiClips = next
}

function writeSections(project: Project, draft: SongDraft) {
  if (draft.sectionMode === 'none' || !draft.sections.length) return
  if (!project.sections) project.sections = []
  if (draft.sectionMode === 'replace' && draft.replace) {
    const start = draft.replace.startBeat
    const end = draft.replace.endBeat
    project.sections = project.sections.filter((section) => {
      const sectionEnd = section.startBeat + Math.max(section.durationBeats, 0)
      const inside = section.startBeat >= start - 1e-4 && sectionEnd <= end + 1e-4
      return !(inside && OURS.test(section.name))
    })
  }
  for (const section of draft.sections) {
    const spec = sectionKind(section.kind)
    project.sections.push({
      id: uid('sec'),
      name: section.name,
      kind: section.kind,
      startBeat: section.startBeat,
      durationBeats: section.durationBeats,
      color: spec.color,
    })
  }
  project.sections.sort((a, b) => a.startBeat - b.startBeat || a.name.localeCompare(b.name))
}
