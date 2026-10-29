import { moveAudioClip, splitAudioClip, trimAudioClip } from './clips'
import { splitMidiClip, stretchMidiClip, trimMidiClip } from './edit'
import type { AudioClip, MidiClip, MixGroup, Project, Track } from './types'
import { uid } from './types'

export interface MixerPatch {
  volume?: number
  pan?: number
  mute?: boolean
  solo?: boolean
  soloSafe?: boolean
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function groupForTrack(project: Project, trackId: string) {
  return (project.mixGroups ?? []).find((group) => group.trackIds.includes(trackId)) ?? null
}

export function normalizeMix(project: Project) {
  const mode = project.automationMode
  project.automationMode = mode === 'off' || mode === 'latch' || mode === 'touch' ? mode : 'read'
  const known = new Set(project.tracks.map((track) => track.id))
  project.mixGroups = (project.mixGroups ?? [])
    .map((group) => ({
      id: group.id || uid('grp'),
      name: group.name || 'Link',
      trackIds: (group.trackIds ?? []).filter((id) => known.has(id)),
      faders: group.faders !== false,
      mutes: group.mutes !== false,
      solos: group.solos !== false,
      edits: group.edits !== false,
    }))
    .filter((group) => group.trackIds.length > 0)
  for (const track of project.tracks) {
    track.soloSafe = track.soloSafe === true
    for (const plugin of track.plugins ?? []) plugin.sidechain = plugin.sidechain ?? ''
  }
  for (const plugin of project.masterPlugins ?? []) plugin.sidechain = plugin.sidechain ?? ''
  for (const lane of project.automation ?? []) {
    lane.points = lane.points ?? []
    if (lane.target !== 'volume' && lane.target !== 'pan' && lane.target !== 'send') lane.target = 'plugin'
  }
  return project
}

export function patchMixer(project: Project, trackId: string, patch: MixerPatch) {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) return
  const group = groupForTrack(project, trackId)
  const members = (linked: boolean) => (linked && group ? project.tracks.filter((item) => group.trackIds.includes(item.id)) : [track])
  if (patch.volume != null) {
    const delta = patch.volume - track.volume
    for (const member of members(!!group?.faders)) {
      const next = member.id === track.id ? patch.volume : member.volume + delta
      member.volume = clamp(next, 0, 1.25)
    }
  }
  if (patch.pan != null) {
    const delta = patch.pan - track.pan
    for (const member of members(!!group?.faders)) {
      const next = member.id === track.id ? patch.pan : member.pan + delta
      member.pan = clamp(next, -1, 1)
    }
  }
  if (patch.mute != null) for (const member of members(!!group?.mutes)) member.mute = patch.mute
  if (patch.solo != null) for (const member of members(!!group?.solos)) member.solo = patch.solo
  if (patch.soloSafe != null) track.soloSafe = patch.soloSafe
}

export function setTrackGroup(project: Project, trackId: string, choice: string) {
  project.mixGroups = project.mixGroups ?? []
  for (const group of project.mixGroups) group.trackIds = group.trackIds.filter((id) => id !== trackId)
  project.mixGroups = project.mixGroups.filter((group) => group.trackIds.length > 0)
  if (!choice) return null
  if (choice === 'new') {
    const group: MixGroup = {
      id: uid('grp'),
      name: `Link ${project.mixGroups.length + 1}`,
      trackIds: [trackId],
      faders: true,
      mutes: true,
      solos: true,
      edits: true,
    }
    project.mixGroups.push(group)
    return group
  }
  const group = project.mixGroups.find((item) => item.id === choice)
  if (group && !group.trackIds.includes(trackId)) group.trackIds.push(trackId)
  return group ?? null
}

export function setGroupFlags(project: Project, groupId: string, patch: Partial<Pick<MixGroup, 'faders' | 'mutes' | 'solos' | 'edits' | 'name'>>) {
  const group = (project.mixGroups ?? []).find((item) => item.id === groupId)
  if (!group) return
  Object.assign(group, patch)
}

function editPeers(project: Project, trackId: string) {
  const group = groupForTrack(project, trackId)
  if (!group?.edits) return []
  return project.tracks.filter((track) => track.id !== trackId && group.trackIds.includes(track.id))
}

function audioOverlap(a: AudioClip, b: AudioClip) {
  return a.startSample < b.startSample + b.durationSamples && b.startSample < a.startSample + a.durationSamples
}

function midiOverlap(a: MidiClip, b: MidiClip) {
  return a.startBeat < b.startBeat + b.durationBeats && b.startBeat < a.startBeat + a.durationBeats
}

export function shiftLinkedAudio(project: Project, trackId: string, clipId: string, nextStart: number) {
  const clip = project.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId)
  if (!clip) return []
  const original = { ...clip }
  const delta = nextStart - clip.startSample
  Object.assign(clip, moveAudioClip(clip, nextStart))
  const moved = [clip.id]
  if (!delta) return moved
  for (const track of editPeers(project, trackId)) {
    for (const other of track.clips) {
      if (!audioOverlap(original, other)) continue
      Object.assign(other, moveAudioClip(other, other.startSample + delta))
      moved.push(other.id)
    }
  }
  return moved
}

export function trimLinkedAudio(project: Project, trackId: string, clipId: string, edge: 'start' | 'end', sample: number, bufferLength: (clip: AudioClip) => number) {
  const clip = project.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId)
  if (!clip) return []
  const original = { ...clip }
  const edgeAt = edge === 'start' ? clip.startSample : clip.startSample + clip.durationSamples
  const delta = sample - edgeAt
  Object.assign(clip, trimAudioClip(clip, edge, sample, bufferLength(clip)))
  const moved = [clip.id]
  if (!delta) return moved
  for (const track of editPeers(project, trackId)) {
    for (const other of track.clips) {
      if (!audioOverlap(original, other)) continue
      const next = edge === 'start' ? other.startSample + delta : other.startSample + other.durationSamples + delta
      Object.assign(other, trimAudioClip(other, edge, next, bufferLength(other)))
      moved.push(other.id)
    }
  }
  return moved
}

export function splitLinkedAudio(project: Project, trackId: string, clipId: string, atSample: number) {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) return null
  const index = track.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return null
  const original = { ...track.clips[index] }
  const parts = splitAudioClip(track.clips[index], atSample)
  if (!parts) return null
  track.clips.splice(index, 1, parts[0], parts[1])
  for (const peer of editPeers(project, trackId)) {
    const peerIndex = peer.clips.findIndex((clip) => audioOverlap(original, clip) && atSample > clip.startSample && atSample < clip.startSample + clip.durationSamples)
    if (peerIndex < 0) continue
    const peerParts = splitAudioClip(peer.clips[peerIndex], atSample)
    if (peerParts) peer.clips.splice(peerIndex, 1, peerParts[0], peerParts[1])
  }
  return parts[1].id
}

export function shiftLinkedMidi(project: Project, trackId: string, clipId: string, nextBeat: number) {
  const clip = project.tracks.find((track) => track.id === trackId)?.midiClips.find((item) => item.id === clipId)
  if (!clip) return []
  const original = { ...clip }
  const delta = nextBeat - clip.startBeat
  clip.startBeat = Math.max(0, nextBeat)
  const moved = [clip.id]
  if (!delta) return moved
  for (const track of editPeers(project, trackId)) {
    for (const other of track.midiClips) {
      if (!midiOverlap(original, other)) continue
      other.startBeat = Math.max(0, other.startBeat + delta)
      moved.push(other.id)
    }
  }
  return moved
}

export function splitLinkedMidi(project: Project, trackId: string, clipId: string, atBeat: number) {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) return null
  const index = track.midiClips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return null
  const original = { ...track.midiClips[index] }
  const parts = splitMidiClip(track.midiClips[index], atBeat)
  if (!parts) return null
  track.midiClips.splice(index, 1, parts[0], parts[1])
  for (const peer of editPeers(project, trackId)) {
    const peerIndex = peer.midiClips.findIndex((clip) => {
      const local = atBeat - clip.startBeat
      return midiOverlap(original, clip) && local > 0.02 && local < clip.durationBeats - 0.02
    })
    if (peerIndex < 0) continue
    const peerParts = splitMidiClip(peer.midiClips[peerIndex], atBeat)
    if (peerParts) peer.midiClips.splice(peerIndex, 1, peerParts[0], peerParts[1])
  }
  return parts[1].id
}

function applyMidiEdge(clip: MidiClip, edge: 'start' | 'end', beat: number, stretch: boolean) {
  const next = stretch ? stretchMidiClip(clip, edge, beat) : trimMidiClip(clip, edge, beat)
  clip.startBeat = next.startBeat
  clip.durationBeats = next.durationBeats
  clip.notes = next.notes
}

/** Trim or stretch a MIDI clip and any overlapping clips in a linked edit group. */
export function trimLinkedMidi(project: Project, trackId: string, clipId: string, edge: 'start' | 'end', beat: number, stretch = false) {
  const clip = project.tracks.find((track) => track.id === trackId)?.midiClips.find((item) => item.id === clipId)
  if (!clip) return []
  const original = { ...clip }
  const edgeAt = edge === 'start' ? clip.startBeat : clip.startBeat + clip.durationBeats
  const delta = beat - edgeAt
  applyMidiEdge(clip, edge, beat, stretch)
  const moved = [clip.id]
  if (!delta) return moved
  for (const track of editPeers(project, trackId)) {
    for (const other of track.midiClips) {
      if (!midiOverlap(original, other)) continue
      const next = edge === 'start' ? other.startBeat + delta : other.startBeat + other.durationBeats + delta
      applyMidiEdge(other, edge, next, stretch)
      moved.push(other.id)
    }
  }
  return moved
}

export function linkedAudioTargets(project: Project, trackId: string, clip: AudioClip) {
  const targets: AudioClip[] = []
  for (const track of editPeers(project, trackId)) {
    for (const other of track.clips) if (audioOverlap(clip, other)) targets.push(other)
  }
  return targets
}

export function tracksInGroup(project: Project, group: MixGroup): Track[] {
  return project.tracks.filter((track) => group.trackIds.includes(track.id))
}
