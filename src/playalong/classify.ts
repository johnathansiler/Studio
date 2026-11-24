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

/** Metadata guess. Null when the name does not say. */
export function partFromLabel(text: string): AudioPart | null {
  if (/\b(drum|percussion|perc|kick|snare|hat|clap|rimshot|cymbal|shaker)\b/.test(text) && !/\bbass\b/.test(text)) return 'drums'
  if (/\b(bass|lead|vocal|vox|melody|mono|flute|sax|trumpet|violin|horn)\b/.test(text)) return 'mono'
  if (/\b(chord|keys|piano|guitar|pad|strum|poly|rhodes|organ)\b/.test(text)) return 'poly'
  return null
}

/**
 * Pitch-class spread of one bar. Three or more strong classes is a chord.
 * A single line stays under that.
 */
export function partFromDensity(classesPerBar: number[]) {
  if (!classesPerBar.length) return 'mono' as const
  const mean = classesPerBar.reduce((sum, count) => sum + count, 0) / classesPerBar.length
  return mean >= 2.4 ? 'poly' as const : 'mono' as const
}
