/** Remember a transcription for a clip so opening the sheet again does not recompute it. */

import type { PlayScore } from './types'

const scores = new Map<string, PlayScore>()

export function transcriptionKey(parts: (string | number | null | undefined)[]) {
  return parts.map((part) => (part == null ? '' : String(part))).join('|')
}

export function cachedScore(key: string) {
  return scores.get(key) ?? null
}

export function rememberScore(key: string, score: PlayScore) {
  scores.set(key, score)
  return score
}

export function forgetScore(key?: string) {
  if (key) scores.delete(key)
  else scores.clear()
}
