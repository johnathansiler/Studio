import { monoMix } from '../analysis/mix'
import { isRecordedClip } from '../audio/recordTake'
import { keyFromFilename, keyFromText } from '../library/musicalKey'
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
 * A newer drop replaces an offer that is still being heard.
 */
let offerGeneration = 0

export async function offerLoopKeyShift(
  store: ProjectStore,
  trackId: string,
  clipId: string,
  hint: { catalogKey?: string; drum?: boolean; loop?: boolean; tags?: string[] } = {},
) {
  if (hint.loop === false) return
  const generation = ++offerGeneration
  const clip = store.track(trackId)?.clips.find((item) => item.id === clipId)
  const tagged = loopKeyLabel(hint, clip?.name)
  if (tagged) store.rememberLoopKey(trackId, clipId, tagged)
  const plan = await planLoopKeyShift(store, trackId, clipId, hint)
  if (generation !== offerGeneration || !plan) return
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

/** Shift offer for a selected clip that was left in its own key. Null when it already matches. */
export function clipShiftPlan(store: ProjectStore, trackId: string, clipId: string): KeyShiftRequest | null {
  const track = store.track(trackId)
  const clip = track?.clips.find((item) => item.id === clipId)
  if (!track || !clip || !trackAcceptsLoopKey(track)) return null
  if (isRecordedClip(clip) || clipIsRecordedTake(clip.source)) return null
  if (clip.stretch?.mode === 'beats' || nameIsDrum(clip.name)) return null
  if ((clip.stretch?.semitones ?? 0) !== 0 && clip.keyShift) return null
  const project = projectMusicalKey(store.scaleState())
  if (!project) return null
  const label = clip.loopKey || (clip.hearing?.clearKey ? clip.hearing.key : '') || loopKeyLabel({ tags: [clip.name] }, clip.name)
  const loop = label ? parseMusicalKey(label) : null
  if (!loop) return null
  const fit = fitToProject(loop, project)
  if (fit.semitones === 0) return null
  return {
    trackId,
    clipId,
    semitones: fit.semitones,
    from: fit.from,
    to: fit.to,
    tonicOnly: fit.modesDiffer,
  }
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
  const tagged = clip.loopKey || loopKeyLabel(hint, clip.name)
  let loop = tagged ? parseMusicalKey(tagged) : null
  if (!loop) {
    const asset = store.buffers.get(clip.bufferId)
    if (!asset?.channels.length) return null
    const offset = Math.max(0, clip.offsetSamples || 0)
    const source = Math.max(1, clip.stretch?.sourceSamples || clip.durationSamples)
    const slices = asset.channels
      .map((channel) => channel.subarray(offset, Math.min(channel.length, offset + source)))
      .filter((channel) => channel.length > 0)
    if (!slices.length) return null
    const { detectKeyOffThread } = await import('../analysis/keyJob')
    let heard
    try {
      heard = await detectKeyOffThread(monoMix(slices), asset.sampleRate)
    } catch {
      return null
    }
    const live = store.track(trackId)?.clips.find((item) => item.id === clipId)
    if (!live) return null
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

/** Catalog text, a filename, or a tag. A bare note name is not a key. */
export function loopKeyLabel(
  hint: { catalogKey?: string; tags?: string[] },
  name?: string,
): string | null {
  const candidates = [hint.catalogKey, ...(hint.tags ?? []), name]
  for (const candidate of candidates) {
    const text = candidate?.trim()
    if (!text) continue
    const direct = parseMusicalKey(text)
    if (direct && /minor|major|maj|min|m/i.test(text.replace(/[_./-]+/g, ' '))) return direct.label
    const fromFile = keyFromFilename(text)
    if (fromFile && parseMusicalKey(fromFile.label)) return fromFile.label
    const fromText = keyFromText(text)
    if (fromText && parseMusicalKey(fromText.label)) return fromText.label
  }
  return null
}
