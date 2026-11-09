/**
 * Offline arrangement sources for bounce and quick export.
 * Timing follows the playback schedulers: tempo-map sample positions,
 * stretched clips, and the instrument each track actually has selected.
 * The speaker safety compressor is not part of this print.
 */

import { compPieces } from '../model/comp'
import { patternHitTrack, transportPatternClips } from '../model/channelRack'
import { rackLanesFor } from '../model/automation'
import { DRUM_PADS, residentDrums } from '../model/drums'
import { ATTACK_SEC, builtinLevel, drumLevel } from './liveStage'
import { prepareClipNotes } from '../model/midiTools'
import { padRegion, normalizePadKit } from '../model/padMachine'
import { renderQuantizedClip } from '../model/quantize'
import { stepPatternOwner } from '../model/stepPlugin'
import { patternPlayRange, renderPattern, type RenderedHit } from '../model/steps'
import { beatSpanSamples, projectSampleBeat } from '../model/tempoMap'
import { linearResample } from '../model/wav'
import type { AudioAsset, AudioClip, MidiNote, PluginInstance, Project, Track } from '../model/types'
import { performancesOn, routeScaler, trackHasScaler } from '../instruments/scaler/model'
import { stepNotes } from '../instruments/scaler/route'
import { hitRoute } from '../instruments/mpc/model'
import { preparePadPcm } from '../instruments/mpc/render'
import { matchBufferRate, renderPatchSpan } from '../instruments/patch/engine'
import { renderNotes, type SampleBuffer } from './rack/dsp'
import { renderSamplerSpan } from './plugins/sampler'
import { clipNeedsStretch, renderClipChannels } from './stretch/engine'
import { SampleCache, type FetchLike } from './multisample/cache'
import { SamplerInstrument, type SamplerNote } from './multisample/engine'
import { isPackAsset, packFromAsset } from './multisample/persist'
import type { SampleRef } from './multisample/types'

const FLOOR = 0.0001
const HIT_PEAK = 0.22

export class LibrarySamplesMissing extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LibrarySamplesMissing'
  }
}

export interface ArrangePrint {
  shouldCancel?: () => void
  /** Used for starter zones that are still URLs. Defaults to the platform fetch. */
  fetchImpl?: FetchLike
}

/**
 * One stereo buffer per track for the bounce window. The mix graph has to hold
 * those together because of sends. Library decode is only the zones for notes
 * inside that window, one download at a time, written straight into the track
 * buffer in short blocks. The catalog itself is not fetched.
 */
export async function renderArrangeInputs(
  project: Project,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
  scheduleEnd = origin + length,
  print?: ArrangePrint | (() => void),
): Promise<Map<string, Float32Array[]>> {
  const options = printOptions(print)
  await prepareLibrarySources(project, assets, origin, scheduleEnd, options)
  const buffers = new Map<string, Float32Array[]>()
  for (const track of project.tracks) {
    options.shouldCancel?.()
    const out = [new Float32Array(length), new Float32Array(length)]
    buffers.set(track.id, out)
    mixAudioClips(out, project, track, assets, origin, length)
    mixMidi(out, project, track, assets, origin, length, scheduleEnd, options.shouldCancel)
  }
  mixStepSequencers(buffers, project, assets, origin, length, scheduleEnd, options.shouldCancel)
  mixPatternClips(buffers, project, assets, origin, length, scheduleEnd, options.shouldCancel)
  return buffers
}

function printOptions(print?: ArrangePrint | (() => void)): ArrangePrint {
  if (typeof print === 'function') return { shouldCancel: print }
  return print ?? {}
}

/**
 * Download only the zones the notes in this window will play, and keep that PCM
 * on the project so a save can round-trip it. A failed or cancelled load throws.
 */
export async function prepareLibrarySources(
  project: Project,
  assets: Map<string, AudioAsset>,
  origin: number,
  scheduleEnd: number,
  print: ArrangePrint = {},
) {
  const cache = new SampleCache(print.fetchImpl)
  for (const track of project.tracks) {
    print.shouldCancel?.()
    if (track.instrument !== 'library' || !track.library) continue
    const events = libraryEvents(project, track, origin, scheduleEnd)
    if (!events.length) continue
    const instrument = new SamplerInstrument(project.sampleRate, cache)
    instrument.setProgram(track.library)
    const planned = instrument.plan(events)
    const needed = new Map<string, SampleRef>()
    for (const note of planned) for (const sample of note.samples) needed.set(sample.id, sample)
    const failed = new Set<string>()
    for (const sample of needed.values()) {
      print.shouldCancel?.()
      const stored = storedSample(sample, assets)
      if (stored) {
        if (stored.pack) cache.holdPack(stored.pack)
        else if (stored.audio) cache.holdAudio(sample.id, stored.audio)
        continue
      }
      if (!sample.url) {
        failed.add(sample.id)
        continue
      }
      try {
        const decoded = await cache.load(sample)
        print.shouldCancel?.()
        if (!decoded?.channels.some((channel) => channel.length > 0)) {
          failed.add(sample.id)
          continue
        }
        const id = sample.bufferId || `lib:${track.id}:${sample.id}`
        if (!assets.has(id)) {
          assets.set(id, { id, name: sample.id, sampleRate: decoded.sampleRate, channels: decoded.channels })
        }
        const owned = track.library.samples.find((item) => item.id === sample.id)
        if (owned) owned.bufferId = id
        sample.bufferId = id
      } catch (error) {
        if (error instanceof Error && error.name === 'BounceCancelled') throw error
        failed.add(sample.id)
      }
    }
    let missing = 0
    for (const note of planned) {
      if (note.attackIds.length > 0 && note.attackIds.every((id) => failed.has(id))) missing += 1
    }
    if (missing > 0) {
      throw new LibrarySamplesMissing(missing === 1 ? 'A library note could not load its sample' : `${missing} library notes could not load their samples`)
    }
  }
}

function storedSample(sample: SampleRef, assets: Map<string, AudioAsset>): { audio?: { sampleRate: number; channels: Float32Array[] }; pack?: ReturnType<typeof packFromAsset> } | null {
  if (sample.bufferId) {
    const asset = assets.get(sample.bufferId)
    if (asset?.channels.some((channel) => channel.length > 0) && !isPackAsset(asset)) {
      return { audio: { sampleRate: asset.sampleRate, channels: asset.channels } }
    }
  }
  if (sample.packId) {
    const packed = assets.get(sample.packId)
    if (packed && isPackAsset(packed)) {
      const pack = packFromAsset({ id: sample.packId, name: packed.name, channels: packed.channels })
      if (pack) return { pack }
    }
  }
  return null
}

function libraryEvents(project: Project, track: Track, origin: number, scheduleEnd: number): SamplerNote[] {
  const events: SamplerNote[] = []
  for (const group of performancesOn(project, track)) {
    if (group.voice.instrument !== 'library') continue
    for (const clip of group.clips) {
      if (clip.slotOnly || clip.scene != null) continue
      for (const note of prepareClipNotes(project, group.owner, clip)) {
        if (note.muted) continue
        const span = beatSpanSamples(project, clip.startBeat + note.startBeat, note.durationBeats)
        if (span.start >= scheduleEnd || span.start + span.duration < origin) continue
        const on = Math.max(0, Math.round(span.start - origin))
        const off = Math.max(0, Math.round(span.start + span.duration - origin))
        events.push({ sample: on, pitch: note.pitch, vel: note.velocity })
        events.push({ sample: off, pitch: note.pitch, vel: 0 })
      }
    }
  }
  return events
}

/**
 * Steps never run as an audio insert. Sampler and Beat Machine are printed
 * into the source buffer, so the offline chain must not run those generators
 * again: their processors replace the buffer and have no note input here.
 */
export function graphPlugins(track: Track): PluginInstance[] {
  return track.plugins.map((plugin) => {
    const generator = plugin.pluginId === 'steps'
      || (plugin.pluginId === 'sampler' && track.instrument === 'sampler')
      || ((plugin.pluginId === 'pads' || plugin.pluginId === 'drum-machine' || plugin.pluginId === '808')
        && (track.instrument === 'pads' || track.instrument === 'drum-machine' || track.instrument === '808'))
    return generator ? { ...plugin, enabled: false } : plugin
  })
}

function mixAudioClips(
  out: Float32Array[],
  project: Project,
  track: Track,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
) {
  for (const clip of track.clips) {
    if (clip.slotOnly) continue
    const pieces = clip.folder
      ? compPieces(clip.folder, clip.fadeInSamples, clip.fadeOutSamples).map((piece) => ({ ...clip, folder: undefined, ...piece, gain: clip.gain }))
      : [clip]
    for (const piece of pieces) mixOneClip(out, project, assets, piece, origin, length)
  }
}

function mixOneClip(
  out: Float32Array[],
  project: Project,
  assets: Map<string, AudioAsset>,
  clip: AudioClip,
  origin: number,
  length: number,
) {
  const asset = assets.get(clip.bufferId)
  if (!asset?.channels.length) return
  const rate = project.sampleRate
  let channels = asset.sampleRate === rate ? asset.channels : asset.channels.map((channel) => linearResample(channel, asset.sampleRate, rate))
  let placed = clip
  if (clipNeedsStretch(clip, project)) {
    const pcm = renderClipChannels(channels, placed, project, 'hq')
    const frames = Math.max(1, pcm[0]?.length ?? 1)
    channels = pcm
    placed = { ...placed, offsetSamples: 0, durationSamples: frames }
  }
  if (placed.warpPoints && placed.warpPoints.length >= 2) {
    const pcm = renderQuantizedClip(channels, placed, rate, project.tempo)
    const frames = Math.max(1, pcm[0]?.length ?? 1)
    channels = pcm
    placed = { ...placed, offsetSamples: 0, durationSamples: frames, warp: undefined }
  }
  const clipEnd = placed.startSample + placed.durationSamples
  const from = Math.max(placed.startSample, origin)
  const to = Math.min(clipEnd, origin + length)
  const clipDur = placed.durationSamples / rate
  const fadeIn = placed.fadeInSamples / rate
  const fadeOut = placed.fadeOutSamples / rate
  for (let i = from; i < to; i++) {
    const rel = (i - placed.startSample) / rate
    let gain = placed.gain
    if (fadeIn > 0 && rel < fadeIn) gain *= rel / fadeIn
    if (fadeOut > 0 && rel > clipDur - fadeOut) gain *= Math.max(0, (clipDur - rel) / fadeOut)
    gain = Math.max(FLOOR, gain)
    const src = placed.offsetSamples + (i - placed.startSample)
    const dst = i - origin
    if (src < 0 || dst < 0 || dst >= length) continue
    for (let c = 0; c < 2; c++) {
      const channel = channels[Math.min(c, channels.length - 1)]
      out[c][dst] += (channel?.[src] ?? 0) * gain
    }
  }
}

interface TimedNote {
  pitch: number
  fine: number
  velocity: number
  pan: number
  slide: boolean
  tune: number
  filter?: number
  start: number
  duration: number
}

function mixMidi(
  out: Float32Array[],
  project: Project,
  track: Track,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
  scheduleEnd: number,
  shouldCancel?: () => void,
) {
  const groups = performancesOn(project, track)
  for (const group of groups) {
    const notes: TimedNote[] = []
    for (const clip of group.clips) {
      if (clip.slotOnly || clip.scene != null) continue
      for (const note of prepareClipNotes(project, group.owner, clip)) {
        if (note.muted) continue
        const span = beatSpanSamples(project, clip.startBeat + note.startBeat, note.durationBeats)
        if (span.start >= scheduleEnd) continue
        notes.push(timed(note, span.start, span.duration))
      }
    }
    if (notes.length) mixVoice(out, project, group.voice, notes, assets, origin, length, shouldCancel)
  }
}

function timed(note: Pick<MidiNote, 'pitch' | 'fine' | 'velocity' | 'pan' | 'slide' | 'locks'>, start: number, duration: number): TimedNote {
  return {
    pitch: note.pitch,
    fine: note.fine || 0,
    velocity: note.velocity,
    pan: note.pan || 0,
    slide: !!note.slide,
    tune: (note.locks?.tune ?? 0) + (note.fine || 0) / 100,
    filter: note.locks?.filter,
    start,
    duration,
  }
}

function mixVoice(
  out: Float32Array[],
  project: Project,
  track: Track,
  notes: TimedNote[],
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
  shouldCancel?: () => void,
) {
  const rate = project.sampleRate
  const sampler = samplerInsert(track)
  if (sampler?.sampler) {
    const channel = assets.get(sampler.sampler.bufferId)?.channels[0]
    if (!channel?.length) return
    notes.forEach((note, index) => {
      if (index % 16 === 0) shouldCancel?.()
      const dur = Math.max(0.02, note.duration / rate)
      const frames = Math.max(1, Math.ceil((dur + 0.3) * rate))
      const rendered = renderSamplerSpan(sampler, channel, [
        { time: 0, pitch: note.pitch, vel: note.velocity },
        { time: dur, pitch: note.pitch, vel: 0 },
      ], rate, frames)
      addStereo(out, rendered, Math.round(note.start), origin, length, note.pan)
    })
    return
  }
  if (track.instrument === 'library' && track.library) {
    mixLibrary(out, project, track, notes, assets, origin, length)
    return
  }
  if (track.instrument === 'pads') {
    notes.forEach((note, index) => {
      if (index % 16 === 0) shouldCancel?.()
      mixPad(out, project, track, note, assets, origin, length)
    })
    return
  }
  if (track.instrument === 'drum-machine') {
    const drums = residentDrums(rate)
    notes.forEach((note, index) => {
      if (index % 16 === 0) shouldCancel?.()
      const indexPad = DRUM_PADS.findIndex((pad) => pad.pitch === Math.round(note.pitch))
      const hit = indexPad >= 0 ? drums[indexPad] : null
      if (!hit) {
        mixBuiltin(out, note, rate, origin, length)
        return
      }
      const tuned = note.fine ? 2 ** (note.fine / 100) : 1
      placeSample(out, [hit.samples], Math.round(note.start), origin, length, tuned, (t) => holdGain(t, ATTACK_SEC, drumLevel(note.velocity)), note.pan, rate)
    })
    return
  }
  if (track.omniPatch?.enabled) {
    notes.forEach((note, index) => {
      if (index % 8 === 0) shouldCancel?.()
      const buffers = patchBuffers(track, assets, rate)
      const rendered = renderPatchSpan(track.omniPatch!, buffers, note.pitch, note.velocity, Math.max(0.02, note.duration / rate), rate)
      addStereo(out, [rendered.left, rendered.right], Math.round(note.start), origin, length, note.pan)
    })
    return
  }
  if (track.rack) {
    const events = notes.flatMap((note) => {
      const on = Math.round(note.start - origin)
      const off = Math.min(length - 1, Math.round(note.start + note.duration - origin))
      if (off < 0 || on >= length) return []
      return [
        { sample: Math.max(0, on), pitch: note.pitch, vel: note.velocity, slide: note.slide },
        { sample: Math.max(0, off), pitch: note.pitch, vel: 0 },
      ]
    })
    if (!events.length) return
    const buffers = new Map<string, SampleBuffer>()
    for (const [id, asset] of assets) buffers.set(id, { sampleRate: asset.sampleRate, channels: asset.channels })
    const rendered = renderNotes(track.rack, events, rate, project.tempo, length, buffers, rackLanesFor(project, track.id))
    addStereo(out, rendered, origin, origin, length, 0)
    return
  }
  notes.forEach((note, index) => {
    if (index % 16 === 0) shouldCancel?.()
    mixBuiltin(out, note, rate, origin, length)
  })
}

function mixLibrary(
  out: Float32Array[],
  project: Project,
  track: Track,
  notes: TimedNote[],
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
) {
  const program = track.library
  if (!program || !notes.length) return
  const rate = project.sampleRate
  const bank = new SampleCache(async () => new Response(null, { status: 404 }))
  const seen = new Set<string>()
  for (const sample of program.samples ?? []) {
    const stored = storedSample(sample, assets)
    if (!stored) continue
    if (stored.pack) {
      if (sample.packId && !seen.has(sample.packId)) {
        seen.add(sample.packId)
        bank.holdPack(stored.pack)
      }
    } else if (stored.audio) bank.holdAudio(sample.id, stored.audio)
  }
  const events: SamplerNote[] = []
  for (const note of notes) {
    const on = Math.round(note.start - origin)
    const off = Math.round(note.start + note.duration - origin)
    if (off < 0 || on >= length) continue
    events.push({ sample: Math.max(0, on), pitch: note.pitch, vel: note.velocity })
    events.push({ sample: Math.min(length - 1, Math.max(0, off)), pitch: note.pitch, vel: 0 })
  }
  if (!events.length) return
  const instrument = new SamplerInstrument(rate, bank)
  instrument.setProgram(program)
  const ordered = events.slice().sort((a, b) => a.sample - b.sample || b.vel - a.vel)
  let cursor = 0
  let offset = 0
  while (offset < length) {
    while (cursor < ordered.length && ordered[cursor].sample <= offset) {
      const event = ordered[cursor]
      if (event.vel <= 0) instrument.noteOff(event.pitch, event.vel)
      else instrument.noteOn(event.pitch, event.vel)
      cursor += 1
    }
    const next = ordered[cursor]?.sample ?? length
    const count = Math.min(128, length - offset, Math.max(1, next - offset))
    const block = instrument.render(count)
    for (let i = 0; i < count; i++) {
      out[0][offset + i] += block[0][i] || 0
      out[1][offset + i] += block[1][i] || 0
    }
    offset += count
  }
}

function mixPad(
  out: Float32Array[],
  project: Project,
  track: Track,
  note: TimedNote,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
) {
  const kit = normalizePadKit(track.padKit)
  const pads = kit.banks.flat()
  const pad = pads.find((item) => item.pitch === note.pitch)
  if (pad?.muted) return
  const route = hitRoute(kit, pad ?? { muted: false })
  if (!route.audio) return
  const rate = project.sampleRate
  const layer = pad?.layers.find((item) => item.bufferId) ?? pad?.layers[0]
  let pcm: Float32Array | null = null
  let sourceRate = rate
  if (layer?.bufferId) {
    const asset = assets.get(layer.bufferId)
    const channel = asset?.channels[0]
    if (asset && channel?.length) {
      pcm = channel
      sourceRate = asset.sampleRate
    }
  }
  const region = padRegion(pad)
  const prepared = pcm?.length ? preparePadPcm(pcm, region) : null
  let samples = prepared?.length ? (sourceRate === rate ? prepared : linearResample(prepared, sourceRate, rate)) : null
  if (!samples?.length) {
    const drums = residentDrums(rate)
    const index = DRUM_PADS.findIndex((item) => item.pitch === Math.round(note.pitch))
    samples = index >= 0 ? drums[index].samples : null
  }
  if (!samples?.length) return
  const tune = (note.tune || pad?.tune || 0) + (layer?.tune ?? 0)
  const playback = 2 ** (tune / 12)
  const decay = Math.max(0.05, Math.min(1, pad?.decay ?? 1))
  const dur = Math.max(0.04, (samples.length / rate) * decay)
  const peak = Math.max(0.0002, Math.min(1, note.velocity))
  const level = pad?.muted ? 0 : (pad?.level ?? 1)
  const attack = Math.min(0.003, dur * 0.25)
  const linear = !(dur > attack + 0.008)
  placeSample(out, [samples], Math.round(note.start), origin, length, playback, (t) => {
    if (t < 0 || t >= dur + 0.01) return 0
    let gain = peak
    if (linear) {
      gain = t < dur * 0.4
        ? peak * (t / Math.max(1e-4, dur * 0.4))
        : peak * (1 - (t - dur * 0.4) / Math.max(1e-4, dur * 0.6))
    } else if (t < attack) gain = expSeg(t, 0, attack, FLOOR, peak)
    else gain = expSeg(t, attack, dur, peak, FLOOR)
    return gain * level
  }, note.pan || pad?.pan || 0, rate, region.loop)
}

function mixBuiltin(out: Float32Array[], note: TimedNote, rate: number, origin: number, length: number) {
  const dur = Math.max(0.05, note.duration / rate)
  const total = Math.min(length + Math.round(rate), Math.ceil((dur + 0.03) * rate))
  const freq = 440 * 2 ** ((note.pitch + note.tune - 69) / 12)
  const peak = builtinLevel(note.velocity)
  const startCut = note.filter == null ? 2200 : Math.max(80, 200 + note.filter * 8000)
  const ramp = Math.min(0.3, dur)
  const releaseAt = Math.max(0.05, dur)
  const filter = setBiquad('low', startCut, 1, rate)
  const pcm = new Float32Array(total)
  let phase = 0
  for (let i = 0; i < total; i++) {
    const t = i / rate
    const cut = expSeg(t, 0, ramp, startCut, 900)
    if (i % 8 === 0) setBiquad('low', cut, 1, rate, filter)
    phase += freq / rate
    const saw = 2 * ((phase % 1) - 0.5)
    const gain = t < ATTACK_SEC
      ? expSeg(t, 0, ATTACK_SEC, FLOOR, peak)
      : expSeg(t, ATTACK_SEC, releaseAt, peak, FLOOR)
    pcm[i] = finite(tick(filter, saw) * gain)
  }
  const [left, right] = panPair(note.pan)
  addStereo(out, [pcm, pcm], Math.round(note.start), origin, length, 0, left, right)
}

function mixStepSequencers(
  buffers: Map<string, Float32Array[]>,
  project: Project,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
  scheduleEnd: number,
  shouldCancel?: () => void,
) {
  const fromBeat = projectSampleBeat(project, origin)
  const toBeat = projectSampleBeat(project, scheduleEnd)
  for (const track of project.tracks) {
    shouldCancel?.()
    const plugin = track.plugins.find((item) => item.pluginId === 'steps' && item.enabled && item.steps?.patterns.length)
    if (!plugin?.steps) continue
    const song = (plugin.params.song ?? 0) >= 0.5
    const owned = new Set(plugin.steps.patterns.map((pattern) => pattern.id))
    const clips = (project.patternClips ?? []).filter((clip) => (
      clip.scene == null
      && !clip.suppressed
      && owned.has(clip.patternId)
      && (!clip.trackId || clip.trackId === track.id)
    ))
    const hits: { hit: RenderedHit; startBeat: number }[] = []
    if (song && clips.length) {
      for (const clip of clips) {
        const pattern = plugin.steps.patterns.find((item) => item.id === clip.patternId)
        if (!pattern) continue
        const range = patternPlayRange(clip)
        for (const hit of renderPattern(pattern, range.from, range.to)) {
          hits.push({ hit, startBeat: clip.startBeat + (hit.startBeat - range.from) })
        }
      }
    } else {
      const pattern = plugin.steps.patterns.find((item) => item.id === plugin.steps!.activeId) ?? plugin.steps.patterns[0]
      if (!pattern) continue
      for (const hit of renderPattern(pattern, fromBeat, toBeat)) hits.push({ hit, startBeat: hit.startBeat })
    }
    hits.forEach((item, index) => {
      if (index % 24 === 0) shouldCancel?.()
      const span = beatSpanSamples(project, item.startBeat, item.hit.durationBeats)
      if (span.start < origin - project.sampleRate || span.start >= scheduleEnd) return
      if (trackHasScaler(track)) {
        const shaped = stepNotes(project, track, item.hit.pitch, item.hit.velocity, Math.max(0.05, item.hit.durationBeats), Math.floor(item.startBeat / 4))
        if (shaped) {
          for (const note of shaped) {
            if (note.hear === 'midi') continue
            const dest = project.tracks.find((row) => row.id === note.trackId) ?? track
            const bus = buffers.get(dest.id)
            if (!bus) continue
            const dur = beatSpanSamples(project, item.startBeat, note.durationBeats).duration
            mixVoice(bus, project, routeScaler(project, dest).voice, [timed({
              pitch: note.pitch,
              fine: note.fine,
              velocity: note.velocity,
              pan: item.hit.pan,
            }, span.start, dur)], assets, origin, length)
          }
          return
        }
      }
      const bus = buffers.get(track.id)
      if (!bus) return
      mixHit(bus, project, { ...item.hit, output: null }, span.start, span.duration / project.sampleRate, assets, origin, length)
    })
  }
}

function mixPatternClips(
  buffers: Map<string, Float32Array[]>,
  project: Project,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
  scheduleEnd: number,
  shouldCancel?: () => void,
) {
  const clips = transportPatternClips(project, false)
  for (const clip of clips) {
    if (clip.scene != null || clip.suppressed || clip.id === 'live-pattern') continue
    if (stepPatternOwner(project, clip.patternId)) continue
    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
    if (!pattern) continue
    const range = patternPlayRange(clip)
    const hits = renderPattern(pattern, range.from, range.to)
    hits.forEach((hit, index) => {
      if (index % 24 === 0) shouldCancel?.()
      const span = beatSpanSamples(project, clip.startBeat + (hit.startBeat - range.from), hit.durationBeats)
      if (span.start < origin - project.sampleRate || span.start >= scheduleEnd) return
      const dest = patternHitTrack(project, hit, clip) ?? project.tracks[0]?.id
      const bus = dest ? buffers.get(dest) : undefined
      if (!bus) return
      mixHit(bus, project, hit, span.start, span.duration / project.sampleRate, assets, origin, length)
    })
  }
}

function mixHit(
  out: Float32Array[],
  project: Project,
  hit: RenderedHit,
  startSample: number,
  dur: number,
  assets: Map<string, AudioAsset>,
  origin: number,
  length: number,
) {
  const level = Math.max(0, hit.volume ?? 1)
  if (level <= 0.0001) return
  const rate = project.sampleRate
  const peak = Math.max(0.001, HIT_PEAK * hit.velocity * level)
  const env = (t: number, release: number) => shapedGain(t, 0.005, release, peak)
  if (hit.sampleId) {
    const asset = assets.get(hit.sampleId)
    if (asset?.channels.length) {
      const channels = asset.sampleRate === rate ? asset.channels : asset.channels.map((channel) => linearResample(channel, asset.sampleRate, rate))
      const playback = 2 ** ((hit.pitch - 60 + hit.fine / 100) / 12)
      placeSample(out, channels, Math.round(startSample), origin, length, playback, (t) => env(t, Math.max(0.05, dur)), hit.pan, rate)
      return
    }
  }
  if (hit.kind === 'note') {
    mixBuiltin(out, timed({
      pitch: hit.pitch,
      fine: hit.fine,
      velocity: hit.velocity,
      pan: hit.pan,
    }, startSample, Math.max(0.05, dur) * rate), rate, origin, length)
    return
  }
  if (hit.kind === 'kick') {
    const voice = Math.min(0.28, dur + 0.05)
    const sweep = Math.max(0.02, Math.min(0.18, dur))
    renderOsc(out, startSample, voice, rate, origin, length, hit.pan, (t, phase) => {
      const freq = expSeg(t, 0, sweep, 160, 48)
      return { sample: Math.sin(2 * Math.PI * phase.p), freq, gain: env(t, voice) }
    })
    return
  }
  if (hit.kind === 'perc') {
    const voice = Math.min(0.16, dur)
    const freq = 440 * 2 ** ((hit.pitch - 69) / 12)
    renderOsc(out, startSample, voice, rate, origin, length, hit.pan, (t, phase) => ({
      sample: phase.p % 1 < 0.5 ? 1 : -1,
      freq,
      gain: env(t, voice),
    }))
    return
  }
  if (hit.kind === 'openhat' || hit.kind === 'tom' || hit.kind === 'cymbal') {
    const drums = residentDrums(rate)
    const index = DRUM_PADS.findIndex((pad) => pad.pitch === Math.round(hit.pitch))
    if (index >= 0) {
      const gate = Math.max(0.08, Math.min(1, (hit.durationBeats || 0.2) / 0.2))
      const frames = Math.max(1, Math.round(drums[index].samples.length * gate))
      placeSample(out, [drums[index].samples.subarray(0, frames)], Math.round(startSample), origin, length, 1, (t) => {
        const attack = 0.003
        return t < attack ? expSeg(t, 0, attack, FLOOR, peak) : peak
      }, hit.pan, rate)
      return
    }
  }
  if (hit.kind === 'hat') {
    renderNoise(out, startSample, Math.min(0.06, dur), rate, origin, length, hit.pan, 'high', 7000, (t, voice) => env(t, voice))
    return
  }
  if (hit.kind === 'clap') {
    renderNoise(out, startSample, Math.min(0.18, dur), rate, origin, length, hit.pan, 'band', 1400, (t, voice) => env(t, voice))
    return
  }
  const voice = Math.min(0.16, dur)
  renderNoise(out, startSample, voice, rate, origin, length, hit.pan, 'high', 800, (t, span) => env(t, span))
  renderOsc(out, startSample, 0.08, rate, origin, length, hit.pan, (t) => ({
    sample: triangle(t * 190),
    freq: 0,
    gain: env(t, 0.08) * 0.4,
  }), true)
}

function samplerInsert(track: Track | undefined): PluginInstance | null {
  if (!track || track.instrument !== 'sampler') return null
  return track.plugins.find((plugin) => plugin.pluginId === 'sampler' && plugin.enabled && plugin.sampler?.bufferId) ?? null
}

function patchBuffers(track: Track, assets: Map<string, AudioAsset>, rate: number) {
  const buffers = new Map<string, Float32Array>()
  for (const layer of track.omniPatch?.layers ?? []) {
    if (!layer.bufferId || buffers.has(layer.bufferId)) continue
    const asset = assets.get(layer.bufferId)
    const channel = asset?.channels[0]
    if (!asset || !channel?.length) continue
    buffers.set(layer.bufferId, matchBufferRate(channel, asset.sampleRate, rate))
  }
  return buffers
}

function placeSample(
  out: Float32Array[],
  channels: ArrayLike<number>[],
  startSample: number,
  origin: number,
  length: number,
  playback: number,
  gainAt: (t: number) => number,
  pan: number,
  rate: number,
  loop = false,
) {
  const lead = channels[0]
  if (!lead?.length) return
  const [left, right] = panPair(pan)
  const speed = Math.max(0.05, playback)
  const frames = Math.min(length + Math.round(rate), Math.ceil((lead.length / speed + 0.02) * (loop ? 4 : 1)))
  for (let i = 0; i < frames; i++) {
    const dst = startSample + i - origin
    if (dst >= length) break
    const pos = i * speed
    const span = lead.length
    const wrapped = loop && span > 2 ? pos % span : pos
    if (!loop && wrapped >= span) break
    if (dst < 0) continue
    const gain = gainAt(i / rate)
    const l = readAt(lead, wrapped)
    const r = channels[1] ? readAt(channels[1], wrapped) : l
    out[0][dst] += finite(l * gain * left)
    out[1][dst] += finite(r * gain * right)
  }
}

function renderOsc(
  out: Float32Array[],
  startSample: number,
  dur: number,
  rate: number,
  origin: number,
  length: number,
  pan: number,
  sampleAt: (t: number, phase: { p: number }) => { sample: number; freq: number; gain: number },
  freePhase = false,
) {
  const frames = Math.min(length + Math.round(rate), Math.ceil((dur + 0.02) * rate))
  const [left, right] = panPair(pan)
  const phase = { p: 0 }
  let acc = 0
  for (let i = 0; i < frames; i++) {
    const dst = startSample + i - origin
    const t = i / rate
    const voiced = sampleAt(t, phase)
    if (!freePhase && voiced.freq > 0) acc += voiced.freq / rate
    phase.p = freePhase ? t : acc
    if (dst < 0) continue
    if (dst >= length) break
    const value = finite(voiced.sample * voiced.gain)
    out[0][dst] += value * left
    out[1][dst] += value * right
  }
}

function renderNoise(
  out: Float32Array[],
  startSample: number,
  dur: number,
  rate: number,
  origin: number,
  length: number,
  pan: number,
  kind: 'low' | 'high' | 'band',
  freq: number,
  gainAt: (t: number, dur: number) => number,
) {
  const frames = Math.min(length + 64, Math.ceil((dur + 0.02) * rate))
  const noise = noiseAt(rate)
  const filter = setBiquad(kind, freq, 1, rate)
  const [left, right] = panPair(pan)
  for (let i = 0; i < frames; i++) {
    const dst = startSample + i - origin
    if (dst >= length) break
    const value = finite(tick(filter, noise[i % noise.length] || 0) * gainAt(i / rate, dur))
    if (dst < 0) continue
    out[0][dst] += value * left
    out[1][dst] += value * right
  }
}

function addStereo(
  out: Float32Array[],
  channels: ArrayLike<number>[],
  startSample: number,
  origin: number,
  length: number,
  pan: number,
  leftGain = 1,
  rightGain = 1,
) {
  const [panL, panR] = pan ? panPair(pan) : [leftGain, rightGain]
  const left = channels[0]
  const right = channels[1] ?? channels[0]
  if (!left) return
  for (let i = 0; i < left.length; i++) {
    const dst = startSample + i - origin
    if (dst < 0) continue
    if (dst >= length) break
    out[0][dst] += finite((left[i] || 0) * panL)
    out[1][dst] += finite((right?.[i] || 0) * panR)
  }
}

function shapedGain(t: number, attack: number, release: number, peak: number) {
  if (t < 0) return 0
  if (t < attack) return expSeg(t, 0, attack, FLOOR, peak)
  return expSeg(t, attack, Math.max(attack + 0.001, release), peak, FLOOR)
}

function holdGain(t: number, attack: number, peak: number) {
  if (t < attack) return expSeg(Math.max(0, t), 0, attack, FLOOR, peak)
  return peak
}

function expSeg(t: number, t0: number, t1: number, v0: number, v1: number) {
  if (!(t1 > t0)) return t >= t1 ? v1 : v0
  if (t <= t0) return v0
  if (t >= t1) return v1
  const span = (t - t0) / (t1 - t0)
  return v0 * (v1 / v0) ** span
}

function panPair(pan: number): [number, number] {
  const value = Math.max(-1, Math.min(1, pan || 0))
  if (Math.abs(value) <= 0.02) return [1, 1]
  const angle = ((value + 1) * Math.PI) / 4
  return [Math.cos(angle), Math.sin(angle)]
}

function readAt(channel: ArrayLike<number>, pos: number) {
  const i0 = Math.floor(pos)
  if (i0 < 0 || i0 >= channel.length) return 0
  const i1 = Math.min(channel.length - 1, i0 + 1)
  const frac = pos - i0
  return (channel[i0] || 0) * (1 - frac) + (channel[i1] || 0) * frac
}

function triangle(phase: number) {
  const x = phase % 1
  return 4 * Math.abs(x - 0.5) - 1
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
  x1: number
  x2: number
  y1: number
  y2: number
}

function setBiquad(kind: 'low' | 'high' | 'band', freq: number, q: number, sampleRate: number, state?: Biquad): Biquad {
  const f = Math.max(20, Math.min(sampleRate * 0.45, freq))
  const w0 = (2 * Math.PI * f) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const alpha = sin / (2 * Math.max(0.05, q))
  let b0 = 0
  let b1 = 0
  let b2 = 0
  if (kind === 'low') {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
  } else if (kind === 'high') {
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
  } else {
    b0 = alpha
    b1 = 0
    b2 = -alpha
  }
  const a0 = 1 + alpha
  const next = state ?? { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 }
  next.b0 = b0 / a0
  next.b1 = b1 / a0
  next.b2 = b2 / a0
  next.a1 = (-2 * cos) / a0
  next.a2 = (1 - alpha) / a0
  return next
}

function tick(filter: Biquad, x: number) {
  const y = filter.b0 * x + filter.b1 * filter.x1 + filter.b2 * filter.x2 - filter.a1 * filter.y1 - filter.a2 * filter.y2
  filter.x2 = filter.x1
  filter.x1 = x
  filter.y2 = filter.y1
  filter.y1 = y
  return y
}

const noiseCache = new Map<number, Float32Array>()

function noiseAt(sampleRate: number) {
  const cached = noiseCache.get(sampleRate)
  if (cached) return cached
  const data = new Float32Array(sampleRate)
  let seed = 0x6d2b79f5
  for (let i = 0; i < data.length; i++) {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1)
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61)
    data[i] = ((seed >>> 0) / 4294967296) * 2 - 1
  }
  noiseCache.set(sampleRate, data)
  return data
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0
}
