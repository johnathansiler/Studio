import { INSTRUMENT_FAMILIES, type InstrumentFamily } from './types'

const RULES: { family: InstrumentFamily; pattern: RegExp }[] = [
  { family: 'Woodwinds', pattern: /\b(woodwinds?|flute|clarinet|oboe|bassoon|sax|saxophone|piccolo|recorder)\b/i },
  { family: 'Brass', pattern: /\b(brass|trumpet|trombone|french horn|horn|tuba|flugel)\b/i },
  { family: 'Mallets', pattern: /\b(mallets?|xylophone|marimba|vibraphone|vibes|glockenspiel|glock)\b/i },
  { family: 'Guitar', pattern: /\b(guitars?)\b/i },
  { family: 'Strings', pattern: /\b(strings?|violin|viola|cello|celli|contrabass|double bass|ensemble)\b/i },
  { family: 'Bass', pattern: /\b(basses|bass)\b/i },
  { family: 'Keys', pattern: /\b(keys|piano|organ|rhodes|clav|harpsichord|electric piano)\b/i },
  { family: 'Synth', pattern: /\b(synths?|pad|lead|pluck)\b/i },
  { family: 'World', pattern: /\b(world|harp|koto|sitar|steel drum|steeldrum|djembe|shakuhachi|oud|erhu|guzheng)\b/i },
]

function namedFamily(value: string | undefined): InstrumentFamily | null {
  const text = value?.trim().toLowerCase()
  if (!text) return null
  return INSTRUMENT_FAMILIES.find((family) => family.toLowerCase() === text) ?? null
}

const CATEGORY: Record<string, InstrumentFamily> = {
  keys: 'Keys',
  bass: 'Bass',
  guitar: 'Guitar',
  synth: 'Synth',
  strings: 'Strings',
  brass: 'Brass',
  woodwinds: 'Woodwinds',
  mallets: 'Mallets',
  world: 'World',
  choir: 'Synth',
  orchestral: 'Strings',
}

export function familyFor(entry: { family?: string; category?: string; instrument?: string; name?: string; tags?: string[]; pack?: string }): InstrumentFamily {
  const explicit = namedFamily(entry.family) ?? (entry.category ? CATEGORY[entry.category.trim().toLowerCase()] : undefined)
  if (explicit) return explicit
  const hay = `${entry.instrument ?? ''} ${entry.name ?? ''} ${(entry.tags ?? []).join(' ')} ${entry.pack ?? ''}`
  for (const rule of RULES) {
    if (rule.pattern.test(hay)) return rule.family
  }
  return 'World'
}
