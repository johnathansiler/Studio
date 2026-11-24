/** Open or closed. The sheet always reads the selected clip, so it cannot float free. */

import type { ProjectStore } from '../state/store'

export type AlongKind = 'audio' | 'midi' | 'pattern'

export interface AlongSelection {
  trackId: string
  clipId: string
  kind: AlongKind
}

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function playAlongOpen() {
  return open
}

export function setPlayAlongOpen(next: boolean) {
  if (open === next) return
  open = next
  emit()
}

export function togglePlayAlong() {
  open = !open
  emit()
}

export function subscribePlayAlong(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The clip the dock button and the sheet both follow. */
export function alongSelection(store: ProjectStore): AlongSelection | null {
  if (store.selectedClipId) {
    for (const track of store.project.tracks) {
      if (track.clips.some((clip) => clip.id === store.selectedClipId)) {
        return { trackId: track.id, clipId: store.selectedClipId, kind: 'audio' }
      }
    }
  }
  if (store.selectedMidiClipId) {
    for (const track of store.project.tracks) {
      if (track.midiClips.some((clip) => clip.id === store.selectedMidiClipId)) {
        return { trackId: track.id, clipId: store.selectedMidiClipId, kind: 'midi' }
      }
    }
  }
  if (store.selectedPatternClipId) {
    const clip = store.project.patternClips?.find((item) => item.id === store.selectedPatternClipId)
    if (clip) return { trackId: clip.trackId || store.selectedTrackId || '', clipId: clip.id, kind: 'pattern' }
  }
  return null
}
