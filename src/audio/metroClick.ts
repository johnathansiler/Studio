/** Metronome click. Count-in is quieter and darker than the click you hear while playing. */

export interface ClickVoice {
  type: OscillatorType
  /** Hz. Beat 1 stays higher than the other beats. */
  frequency: number
  /** Peak gain into the metronome bus, before the bus trim. */
  peak: number
  /** Lowpass in Hz. Missing means the oscillator is heard directly. */
  lowpass: number | null
  /** Seconds from the start until the peak. */
  attack: number
  /**
   * Seconds the peak is held. A click that falls away in a few milliseconds
   * is gone before the master analyser window and the next meter poll.
   */
  hold: number
  /** Seconds to fall from the peak back to the floor. */
  decay: number
}

/** About −9 dB. Inside the −8 to −10 dB window, still sample-accurate. */
const COUNT_IN_GAIN = 10 ** (-9 / 20)

const LIVE_ACCENT = 0.35
const LIVE_BEAT = 0.18

/** Long enough to fill a 256-sample master-meter window and the next display frame. */
const CLICK_ATTACK = 0.002
const CLICK_HOLD = 0.06
const CLICK_DECAY = 0.02

export function clickVoice(accent: boolean, countIn: boolean): ClickVoice {
  const shape = { attack: CLICK_ATTACK, hold: CLICK_HOLD, decay: CLICK_DECAY }
  if (countIn) {
    return {
      type: 'sine',
      frequency: accent ? 880 : 494,
      peak: (accent ? LIVE_ACCENT : LIVE_BEAT) * COUNT_IN_GAIN,
      lowpass: 1200,
      ...shape,
    }
  }
  return {
    type: 'square',
    frequency: accent ? 1760 : 1180,
    peak: accent ? LIVE_ACCENT : LIVE_BEAT,
    lowpass: null,
    ...shape,
  }
}

/** Seconds from the scheduled start until the oscillator should stop. */
export function clickDuration(voice: ClickVoice) {
  return voice.attack + voice.hold + voice.decay
}

export function gainDb(peak: number, reference: number) {
  return 20 * Math.log10(Math.max(1e-8, peak) / Math.max(1e-8, reference))
}
