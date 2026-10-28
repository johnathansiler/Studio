import type { AudioClip, Project, TempoPoint, Track } from '../model/types'
import { foldChroma, spectralFrames, tuningShift } from './chroma'
import { accumulateBar, blankBars, chordsForBars, histogramFromFrames, keyFromHistogram, type BarChroma } from './harmony'
import { monoMix } from './mix'
import { beatsPerBar } from './audio'
import { sectionsFromBars, type BarActivity } from './sections'
import type { AnalysisResult } from './types'

export interface AnalysisAsset {
  sampleRate: number
  channels: ArrayLike<number>[]
}

function tempoPoints(project: Pick<Project, 'tempo' | 'tempoMap'>): TempoPoint[] {
  const map = [...(project.tempoMap ?? [])].filter((point) => point.bpm > 0 && Number.isFinite(point.beat))
  map.sort((a, b) => a.beat - b.beat)
  if (!map.length || map[0].beat > 0) map.unshift({ beat: 0, bpm: project.tempo })
  return map
}

/** Musical beat at a timeline sample, following the tempo map. */
export function beatAtSample(sample: number, sampleRate: number, tempo: number, map: TempoPoint[]) {
  const target = Math.max(0, sample)
  const points = tempoPoints({ tempo, tempoMap: map })
  let bpm = points[0]?.bpm || tempo
  let beat = 0
  let samples = 0
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (point.beat > beat) {
      const spanBeats = point.beat - beat
      const spanSamples = (spanBeats * sampleRate * 60) / bpm
      if (samples + spanSamples >= target) return beat + ((target - samples) * bpm) / (sampleRate * 60)
      samples += spanSamples
      beat = point.beat
    }
    bpm = point.bpm
  }
  return beat + (Math.max(0, target - samples) * bpm) / (sampleRate * 60)
}

function clipEndBeat(clip: AudioClip, project: Project, map: TempoPoint[]) {
  return beatAtSample(clip.startSample + clip.durationSamples, project.sampleRate, project.tempo, map)
}

function arrangementEnd(project: Project, map: TempoPoint[]) {
  const barBeats = beatsPerBar(project.timeSignature)
  let end = barBeats
  for (const track of project.tracks) {
    if (track.mute) continue
    for (const clip of track.midiClips) {
      if (clip.slotOnly) continue
      end = Math.max(end, clip.startBeat + clip.durationBeats)
    }
    for (const clip of track.clips) {
      if (clip.slotOnly) continue
      end = Math.max(end, clipEndBeat(clip, project, map))
    }
  }
  return end
}

function sliceChannel(channel: ArrayLike<number>, start: number, length: number) {
  const out = new Float32Array(Math.max(0, length))
  const from = Math.max(0, start)
  for (let i = 0; i < out.length; i++) {
    const sample = channel[from + i] || 0
    if (Number.isFinite(sample)) out[i] = sample
  }
  return out
}

function addPitch(bar: BarChroma, pitch: number, weight: number) {
  const pc = ((Math.round(pitch) % 12) + 12) % 12
  bar.chroma[pc] += weight
  if (pitch < 52) bar.bass[pc] += weight
  bar.energy += weight
}

function analyzeClip(clip: AudioClip, asset: AnalysisAsset, project: Project, map: TempoPoint[], bars: BarChroma[], barBeats: number) {
  const offset = Math.max(0, Math.round(clip.offsetSamples || 0))
  const duration = Math.max(0, Math.round(clip.durationSamples || 0))
  if (!duration) return null
  const mixed = monoMix(asset.channels.map((channel) => sliceChannel(channel, offset, duration)))
  if (mixed.length < 64) return null
  const rate = asset.sampleRate || project.sampleRate
  const frames = spectralFrames(mixed, rate)
  if (!frames.length) return null
  const shift = tuningShift(frames)
  const gain = Math.max(0, clip.gain ?? 1)
  const bufferSeconds = Math.max(1e-6, mixed.length / rate)
  const timelineSpan = Math.max(1, clip.durationSamples || mixed.length)
  let sounded = false
  for (const frame of frames) {
    const timeline = clip.startSample + (frame.time / bufferSeconds) * timelineSpan
    const beat = beatAtSample(timeline, project.sampleRate, project.tempo, map)
    const index = Math.floor(beat / barBeats)
    if (index < 0 || index >= bars.length) continue
    accumulateBar(bars[index], foldChroma(frame.fine, shift), frame.bass, frame.rms * gain, frame.flux)
    sounded = true
  }
  if (!sounded) return null
  return { hist: histogramFromFrames(frames, shift, foldChroma), weight: gain }
}

function readTrack(track: Track, index: number, project: Project, map: TempoPoint[], bars: BarChroma[], masks: string[][], densities: Float32Array, global: Float32Array, buffers: Map<string, AnalysisAsset> | undefined, barBeats: number) {
  if (track.mute || track.type === 'bus' || track.type === 'group') return
  for (const clip of track.midiClips) {
    if (clip.slotOnly) continue
    for (const note of clip.notes) {
      if (note.muted) continue
      const start = clip.startBeat + note.startBeat
      const end = start + Math.max(0, note.durationBeats)
      const first = Math.max(0, Math.floor(start / barBeats))
      const last = Math.min(bars.length - 1, Math.floor((end - 1e-6) / barBeats))
      for (let bar = first; bar <= last; bar++) {
        const overlap = Math.min((bar + 1) * barBeats, end) - Math.max(bar * barBeats, start)
        if (overlap <= 0) continue
        const weight = overlap * Math.max(0.05, note.velocity || 0)
        addPitch(bars[bar], note.pitch, weight)
        global[((Math.round(note.pitch) % 12) + 12) % 12] += weight
        densities[bar] += 1
        masks[bar][index] = '1'
      }
    }
  }
  for (const clip of track.clips) {
    if (clip.slotOnly || !buffers) continue
    const asset = buffers.get(clip.bufferId)
    if (!asset) continue
    const before = bars.map((bar) => bar.energy)
    const heard = analyzeClip(clip, asset, project, map, bars, barBeats)
    if (!heard) continue
    for (let i = 0; i < 12; i++) global[i] += heard.hist[i] * Math.max(0.25, heard.weight)
    for (let bar = 0; bar < bars.length; bar++) {
      if (bars[bar].energy > before[bar] + 1e-6) masks[bar][index] = '1'
    }
  }
}

/**
 * Key, chords, sections, and tempo for an arrangement.
 * Reads MIDI on unmuted tracks and, when `buffers` is passed, their audio clips.
 * `tempo` is the arrangement tempo. Bars follow the tempo map.
 */
export function analyzeProject(project: Project, buffers?: Map<string, AnalysisAsset>): AnalysisResult {
  const barBeats = beatsPerBar(project.timeSignature)
  const map = tempoPoints(project)
  const barCount = Math.max(1, Math.ceil(arrangementEnd(project, map) / barBeats - 1e-9))
  const bars = blankBars(barCount)
  const masks = Array.from({ length: barCount }, () => project.tracks.map(() => ''))
  const densities = new Float32Array(barCount)
  const global = new Float32Array(12)
  project.tracks.forEach((track, index) => readTrack(track, index, project, map, bars, masks, densities, global, buffers, barBeats))
  const fitted = keyFromHistogram(global)
  const { scale, ...key } = fitted
  const activity: BarActivity[] = bars.map((bar, index) => ({
    chroma: bar.chroma,
    energy: bar.energy,
    density: densities[index],
    active: masks[index].filter(Boolean).length,
    mask: masks[index].map((bit) => (bit ? '1' : '0')).join(''),
  }))
  return {
    key,
    scale,
    chordsByBar: chordsForBars(bars, barBeats, { root: fitted.root, scale: fitted.scale }),
    sections: sectionsFromBars(activity, barBeats),
    tempo: project.tempo,
  }
}
