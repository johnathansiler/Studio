/** Slow a buffer with the in-house time stretch. Playback rate stays 1, so pitch stays put. */

import { timeStretch, type StretchMode } from '../audio/stretch/engine'
import { practiceLength } from './sync'
import type { PracticeRate } from './types'

export function stretchChannels(channels: Float32Array[], sampleRate: number, rate: PracticeRate, mode: StretchMode = 'tonal') {
  if (!(rate > 0) || rate >= 1) return channels.map((channel) => Float32Array.from(channel))
  return channels.map((channel) => timeStretch(channel, practiceLength(channel.length, rate), mode, sampleRate, 'preview'))
}
