/** Metronome click. Count-in is quieter and darker than the click you hear while playing. */

export interface ClickVoice {
  type: OscillatorType
  /** Hz. Beat 1 stays higher than the other beats. */
  frequency: number
  /** Peak gain into the metronome bus, before the bus trim. */
  peak: number
  /** Lowpass in Hz. Missing means the oscillator is heard directly. */
  lowpass: number | null
}

/** About −9 dB. Inside the −8 to −10 dB window, still sample-accurate. */
const COUNT_IN_GAIN = 10 ** (-9 / 20)

const LIVE_ACCENT = 0.35
const LIVE_BEAT = 0.18

export function clickVoice(accent: boolean, countIn: boolean): ClickVoice {
  if (countIn) {
    return {
      type: 'sine',
      frequency: accent ? 880 : 494,
      peak: (accent ? LIVE_ACCENT : LIVE_BEAT) * COUNT_IN_GAIN,
      lowpass: 1200,
    }
  }
  return {
    type: 'square',
    frequency: accent ? 1760 : 1180,
    peak: accent ? LIVE_ACCENT : LIVE_BEAT,
    lowpass: null,
  }
}

export function gainDb(peak: number, reference: number) {
  return 20 * Math.log10(Math.max(1e-8, peak) / Math.max(1e-8, reference))
}
