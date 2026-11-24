/** Decide whether an audio clip is a single line, chords, or drums. Labels first, then the sound. */

export type AudioPart = 'mono' | 'poly' | 'drums'

const TEXT_KEYS = ['name', 'soundCategory', 'soundRole', 'soundType'] as const

export function clipText(clip: {
  name?: string
  soundCategory?: string
  soundRole?: string
  soundType?: string
  soundTags?: string[]
}) {
  const parts = TEXT_KEYS.map((key) => clip[key] ?? '')
  if (clip.soundTags?.length) parts.push(...clip.soundTags)
  return parts.join(' ').toLowerCase()
}

/** Metadata guess. Null when the name does not say, so the sound can decide. */
export function partFromLabel(text: string): AudioPart | null {
  if (/\b(drum|percussion|perc|kick|snare|hat|clap|rimshot|cymbal|shaker)\b/.test(text) && !/\bbass\b/.test(text)) return 'drums'
  // A broken chord is still one note at a time. Check it before "piano" or "guitar".
  if (/\barpeggio\b/.test(text)) return 'mono'
  if (/\b(bass|lead|vocal|vox|melody|mono|flute|sax|trumpet|violin|horn)\b/.test(text)) return 'mono'
  if (/\b(chord|keys|pad|strum|poly|rhodes|organ)\b/.test(text)) return 'poly'
  return null
}

/**
 * How many pitch classes sound at once.
 * A bar of an arpeggio collects several classes that never ring together, so
 * the decision uses the average frame, not the whole bar.
 * Three simultaneous classes is a chord. A line, including octaves, stays under that.
 */
export function partFromDensity(classesPerFrame: number[]) {
  if (!classesPerFrame.length) return 'mono' as const
  const mean = classesPerFrame.reduce((sum, count) => sum + count, 0) / classesPerFrame.length
  return mean >= 2.35 ? 'poly' as const : 'mono' as const
}
