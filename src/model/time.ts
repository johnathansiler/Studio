export interface TimeSignature {
  numerator: number
  denominator: number
}

export function samplesPerQuarter(sampleRate: number, tempo: number): number {
  return (sampleRate * 60) / tempo
}

/** Quarter notes contained in one bar (6/8 => 3). */
export function quartersPerBar(sig: TimeSignature): number {
  return sig.numerator * (4 / sig.denominator)
}

export function samplesPerBar(sampleRate: number, tempo: number, sig: TimeSignature): number {
  return samplesPerQuarter(sampleRate, tempo) * quartersPerBar(sig)
}

export function samplesPerBeatUnit(sampleRate: number, tempo: number, sig: TimeSignature): number {
  return samplesPerQuarter(sampleRate, tempo) * (4 / sig.denominator)
}

/** One bar of clicks before the downbeat. The sample rate cancels out. */
export function countInSeconds(tempo: number, sig: TimeSignature): number {
  const beat = samplesPerBeatUnit(48000, Math.max(1, tempo), sig) / 48000
  return Math.max(0, sig.numerator) * beat
}

export function beatsToSamples(beats: number, sampleRate: number, tempo: number): number {
  return beats * samplesPerQuarter(sampleRate, tempo)
}

export function samplesToBeats(samples: number, sampleRate: number, tempo: number): number {
  return samples / samplesPerQuarter(sampleRate, tempo)
}

export function snapSample(
  sample: number,
  sampleRate: number,
  tempo: number,
  enabled: boolean,
  subdivision = 1,
): number {
  const rounded = Math.max(0, Math.round(sample))
  if (!enabled) return rounded
  const unit = samplesPerQuarter(sampleRate, tempo) / subdivision
  if (unit <= 0) return rounded
  return Math.max(0, Math.round(rounded / unit) * unit)
}

export interface MusicalPosition {
  bar: number
  beat: number
  tick: number
}

const TICKS = 960

export function samplesToMusical(
  samples: number,
  sampleRate: number,
  tempo: number,
  sig: TimeSignature,
): MusicalPosition {
  const safe = Math.max(0, samples)
  const quarters = samplesToBeats(safe, sampleRate, tempo)
  const qPerBar = quartersPerBar(sig)
  const barIndex = Math.floor(quarters / qPerBar + 1e-9)
  const within = quarters - barIndex * qPerBar
  const beatUnitQ = 4 / sig.denominator
  const beatIndex = Math.floor(within / beatUnitQ + 1e-9)
  const beatFrac = within / beatUnitQ - beatIndex
  let tick = Math.floor(beatFrac * TICKS + 1e-6)
  let beat = beatIndex + 1
  let bar = barIndex + 1
  if (tick >= TICKS) {
    tick = 0
    beat += 1
  }
  if (beat > sig.numerator) {
    beat = 1
    bar += 1
  }
  return { bar, beat, tick }
}

export function formatBarsBeats(
  samples: number,
  sampleRate: number,
  tempo: number,
  sig: TimeSignature,
): string {
  const p = samplesToMusical(samples, sampleRate, tempo, sig)
  const tick = p.tick.toString().padStart(3, '0')
  return `${p.bar}.${p.beat}.${tick}`
}

export function formatTimecode(samples: number, sampleRate: number, fps = 30): string {
  const totalSeconds = Math.max(0, samples) / sampleRate
  const frames = Math.min(fps - 1, Math.floor((totalSeconds - Math.floor(totalSeconds)) * fps))
  const whole = Math.floor(totalSeconds)
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(frames)}`
}

export function formatClock(seconds: number): string {
  const sign = seconds < 0 ? '-' : ''
  const s = Math.abs(seconds)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${sign}${m}:${r.toFixed(2).padStart(5, '0')}`
}

export function gainToDb(gain: number): string {
  if (gain <= 0.0001) return '-inf'
  const db = 20 * Math.log10(gain)
  return `${db.toFixed(1)} dB`
}

export function projectEndSample(tracks: { clips: { startSample: number; durationSamples: number; slotOnly?: boolean }[]; midiClips: { startBeat: number; durationBeats: number; slotOnly?: boolean }[] }[], sampleRate: number, tempo: number): number {
  let end = sampleRate * 8
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.slotOnly) continue
      end = Math.max(end, clip.startSample + clip.durationSamples)
    }
    for (const clip of track.midiClips) {
      if (clip.slotOnly) continue
      end = Math.max(end, Math.round(beatsToSamples(clip.startBeat + clip.durationBeats, sampleRate, tempo)))
    }
  }
  return end
}
