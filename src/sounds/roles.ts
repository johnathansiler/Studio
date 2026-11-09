import { isDrumSound } from './catalog'
import type { SoundEntry } from './types'

/** Where a catalog row is allowed to appear. Explicit drops can still use the row the person picked. */
export type SoundRole = 'browse' | 'loop' | 'sampler' | 'chop' | 'drum' | 'beat' | 'step'

export type SampleRole = 'kick' | 'snare' | 'clap' | 'hat' | 'perc' | 'other'

export function sampleRole(entry: Pick<SoundEntry, 'name' | 'tags' | 'category' | 'role'>): SampleRole {
  const category = (entry.category ?? '').toLowerCase()
  if (category === 'kick') return 'kick'
  if (category === 'snare') return 'snare'
  if (category === 'clap') return 'clap'
  if (category === 'hat' || category === 'hi-hat') return 'hat'
  if (category === 'tom' || category === 'perc' || category === 'cowbell' || category === 'shaker' || category === 'tambourine' || category === 'percussion' || category === 'cymbal') return 'perc'
  const hay = `${entry.name} ${entry.tags.join(' ')}`.toLowerCase()
  if (/\bkick\b/.test(hay)) return 'kick'
  if (/\bsnare\b/.test(hay)) return 'snare'
  if (/\bclap\b/.test(hay)) return 'clap'
  if (/\b(hat|hi-hat|hihat)\b/.test(hay)) return 'hat'
  if (/\b(cowbell|shaker|tambourine|conga|clave)\b/.test(hay)) return 'perc'
  return 'other'
}

/** Step, pad, and beat lists are drum one-shots. Loops, including percussion loops, stay on the loop and chop lists. */
export function soundsForRole(entries: SoundEntry[], role: SoundRole): SoundEntry[] {
  if (role === 'browse' || role === 'sampler') return entries.filter((entry) => entry.type === 'one-shot' || entry.type === 'loop')
  if (role === 'loop' || role === 'chop') return entries.filter((entry) => entry.type === 'loop')
  return entries.filter((entry) => entry.type === 'one-shot' && isDrumSound(entry))
}

/** Every matching loop. Search narrows the list; nothing is dropped just to shorten the menu. */
export function chopLoops(entries: SoundEntry[], text = '') {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return soundsForRole(entries, 'chop')
    .filter((entry) => {
      if (!tokens.length) return true
      const hay = `${entry.name} ${entry.category ?? ''} ${entry.tags.join(' ')}`.toLowerCase()
      return tokens.every((token) => hay.includes(token))
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Kit categories in the step sequencer. A kick does not satisfy a snare, hat, or perc row. */
export function libraryMatchesCategory(entry: SoundEntry, category: string) {
  if (category === 'All' || category === 'Library') return true
  const role = sampleRole(entry)
  if (category === 'Kicks') return role === 'kick'
  if (category === 'Snares') return role === 'snare' || role === 'clap'
  if (category === 'Hats') return role === 'hat'
  if (category === 'Perc') return role === 'perc'
  return false
}
