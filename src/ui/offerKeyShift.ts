import { isRecordedClip } from '../audio/recordTake'
import type { ProjectStore } from '../state/store'
import {
  clipIsRecordedTake,
  fitToProject,
  keyShiftPrompt,
  nameIsDrum,
  parseMusicalKey,
  projectMusicalKey,
  trackAcceptsLoopKey,
  type KeyFit,
} from '../model/keyFit'

export interface KeyShiftRequest {
  trackId: string
  clipId: string
  semitones: number
  from: string
  to: string
  tonicOnly: boolean
}

/**
 * After a loop lands, ask whether to move it into the project key.
 * Drums, vocal tracks, and recorded takes are left alone.
 */
export async function offerLoopKeyShift(
  store: ProjectStore,
  trackId: string,
  clipId: string,
  hint: { catalogKey?: string; drum?: boolean; loop?: boolean; tags?: string[] } = {},
) {
  if (hint.loop === false) return
  const plan = await planLoopKeyShift(store, trackId, clipId, hint)
  if (!plan) return
  const request = {
    trackId: plan.trackId,
    clipId: plan.clipId,
    semitones: plan.semitones,
    from: plan.from,
    to: plan.to,
    tonicOnly: plan.tonicOnly,
  }
  if (store.project.keyShift === 'keep') return
  if (store.project.keyShift === 'always') {
    await runKeyShift(store, request, false)
    return
  }
  store.presentKeyShiftOffer({ ...request, line: keyShiftPrompt(plan.fit) })
}

export async function runKeyShift(store: ProjectStore, request: KeyShiftRequest, always: boolean) {
  const clip = store.track(request.trackId)?.clips.find((item) => item.id === request.clipId)
  const asset = clip ? store.buffers.get(clip.bufferId) : undefined
  if (clip && asset?.channels?.length) {
    try {
      const { cacheFormantPitch } = await import('../audio/stretch/pitchJob')
      const stretch = clip.stretch
      await cacheFormantPitch({
        channels: asset.channels,
        bufferId: clip.bufferId,
        offsetSamples: clip.offsetSamples,
        sourceSamples: stretch?.sourceSamples || clip.durationSamples,
        sampleRate: store.project.sampleRate,
        semitones: request.semitones,
        cents: 0,
        formant: true,
        mode: stretch?.mode === 'tonal' ? 'tonal' : 'pro',
      })
    } catch {
      /* The clip still stores the semitone shift. Playback renders it again. */
    }
  }
  store.applyKeyShift({ ...request, always })
}

async function planLoopKeyShift(
  store: ProjectStore,
  trackId: string,
  clipId: string,
  hint: { catalogKey?: string; drum?: boolean; loop?: boolean; tags?: string[] },
): Promise<(KeyShiftRequest & { fit: KeyFit }) | null> {
  const track = store.track(trackId)
  const clip = track?.clips.find((item) => item.id === clipId)
  if (!track || !clip || !trackAcceptsLoopKey(track)) return null
  if (isRecordedClip(clip) || clipIsRecordedTake(clip.source)) return null
  if (hint.drum || clip.stretch?.mode === 'beats' || nameIsDrum(clip.name, hint.tags)) return null
  const project = projectMusicalKey(store.scaleState())
  if (!project) return null
  let loop = parseMusicalKey(hint.catalogKey)
  if (!loop) {
    const asset = store.buffers.get(clip.bufferId)
    const channel = asset?.channels[0]
    if (!asset || !channel?.length) return null
    const { detectKey } = await import('../analysis/clipKey')
    const heard = detectKey(channel, asset.sampleRate)
    if (!heard.clear || heard.root == null) return null
    if (heard.scale !== 'ionian' && heard.scale !== 'aeolian') return null
    loop = { root: heard.root, minor: heard.scale === 'aeolian', label: heard.label, scaleId: heard.scale }
  }
  const fit = fitToProject(loop, project)
  if (fit.semitones === 0) return null
  return {
    trackId,
    clipId,
    semitones: fit.semitones,
    from: fit.from,
    to: fit.to,
    tonicOnly: fit.modesDiffer,
    fit,
  }
}
