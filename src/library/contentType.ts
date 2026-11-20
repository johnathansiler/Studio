import type { LibraryInstrumentSummary } from './group'
import type { LibraryEntry } from './types'

/**
 * Producer-facing kinds for the Browse filter.
 * A row can belong to more than one kind: a loop the user uploaded is both
 * a loop and an upload, so Loops does not drop it.
 */
export interface ContentTypeChoice {
  id: string
  label: string
}

const LOOP_TYPES = new Set(['loop', 'loops', 'drum-loop', 'drum loop', 'melodic-loop', 'melodic loop'])
const ONE_SHOT_TYPES = new Set(['one-shot', 'one shot', 'oneshot'])
const SFX_TYPES = new Set(['sfx'])

function clean(value: string) {
  return value.trim().toLowerCase()
}

/** A file the user added, rather than a row that shipped in the catalog. */
export function isUploadEntry(entry: Pick<LibraryEntry, 'key' | 'pack' | 'license' | 'tags'>): boolean {
  const key = entry.key.replace(/\\/g, '/').toLowerCase()
  if (/(^|\/)uploads?\//.test(key)) return true
  const pack = clean(entry.pack)
  if (pack === 'uploads' || pack === 'upload' || pack === 'my library') return true
  if (clean(entry.license) === 'upload') return true
  return entry.tags.some((tag) => clean(tag) === 'upload')
}

export function isDrumKitEntry(entry: Pick<LibraryEntry, 'type' | 'category' | 'instrument' | 'pack' | 'tags' | 'name'>): boolean {
  const type = clean(entry.type)
  if (LOOP_TYPES.has(type) || ONE_SHOT_TYPES.has(type) || SFX_TYPES.has(type) || type === 'multisample note' || type === 'instrument') return false
  const category = clean(entry.category)
  if (type === 'drum-kit' || type === 'drum kit' || type === 'kit') return true
  if (category === 'drum-kit' || category === 'drum kit' || category === 'kit') return true
  const hay = `${entry.name} ${entry.instrument} ${entry.pack} ${entry.tags.join(' ')}`.toLowerCase()
  return /\bdrum ?kits?\b/.test(hay)
}

export function isDrumKitInstrument(item: Pick<LibraryInstrumentSummary, 'name' | 'category' | 'pack'>): boolean {
  const category = clean(item.category)
  if (category === 'drum-kit' || category === 'drum kit' || category === 'kit') return true
  return /\bdrum ?kits?\b/.test(`${item.name} ${item.category} ${item.pack}`.toLowerCase())
}

/**
 * Catalog loops (`type: loop` and the loop folders) and My Library loops
 * (uploads, filename tags). A typed one-shot or effect stays in its own kind.
 */
export function isLoopEntry(entry: LibraryEntry): boolean {
  const type = clean(entry.type)
  if (LOOP_TYPES.has(type)) return true
  if (ONE_SHOT_TYPES.has(type) || SFX_TYPES.has(type) || type === 'multisample note' || type === 'instrument') return false
  return loopSignal(entry)
}

function loopSignal(entry: Pick<LibraryEntry, 'key' | 'category' | 'tags'>): boolean {
  const key = entry.key.replace(/\\/g, '/')
  if (/(^|\/)loops?\//i.test(key)) return true
  const category = clean(entry.category)
  if (category === 'loop' || category === 'loops') return true
  return entry.tags.some((tag) => {
    const word = clean(tag)
    return word === 'loop' || word === 'loops'
  })
}

export function isSfxEntry(entry: LibraryEntry): boolean {
  if (isLoopEntry(entry)) return false
  const type = clean(entry.type)
  if (SFX_TYPES.has(type)) return true
  return clean(entry.category) === 'fx' && !ONE_SHOT_TYPES.has(type) && type !== 'multisample note'
}

export function isOneShotEntry(entry: LibraryEntry): boolean {
  if (isLoopEntry(entry) || isSfxEntry(entry) || isDrumKitEntry(entry)) return false
  return ONE_SHOT_TYPES.has(clean(entry.type))
}

/** True when this row belongs to the selected content type. An empty type matches everything. */
export function entryMatchesContentType(entry: LibraryEntry, type: string): boolean {
  if (!type) return true
  if (type === 'loop') return isLoopEntry(entry)
  if (type === 'one-shot') return isOneShotEntry(entry)
  if (type === 'sfx') return isSfxEntry(entry)
  if (type === 'drum-kit') return isDrumKitEntry(entry)
  if (type === 'upload') return isUploadEntry(entry)
  if (type === 'instrument') return false
  return entry.type === type
}

/** Search words that mean a content type, so "loop" finds loops the filename never called a loop. */
export function contentTypeSearchWord(token: string): string | null {
  const word = clean(token)
  if (word === 'loop' || word === 'loops') return 'loop'
  if (word === 'one-shot' || word === 'oneshot' || word === 'one-shots') return 'one-shot'
  if (word === 'sfx') return 'sfx'
  if (word === 'instrument' || word === 'instruments') return 'instrument'
  if (word === 'kit' || word === 'kits' || word === 'drum-kit' || word === 'drumkit') return 'drum-kit'
  if (word === 'upload' || word === 'uploads') return 'upload'
  return null
}

const CHOICE_LABEL: Record<string, string> = {
  loop: 'Loops',
  'one-shot': 'One-shots',
  instrument: 'Instruments',
  'drum-kit': 'Drum kits',
  sfx: 'SFX',
  upload: 'My Library uploads',
}

export function contentTypeLabel(type: string): string {
  return CHOICE_LABEL[type] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : '')
}

/**
 * Kinds that have at least one row. Empty kinds stay hidden.
 * Loops is first so it is the option a producer is looking for.
 */
export function contentTypeChoices(
  entries: readonly LibraryEntry[],
  instruments: readonly Pick<LibraryInstrumentSummary, 'name' | 'category' | 'pack'>[] = [],
): ContentTypeChoice[] {
  let loops = 0
  let shots = 0
  let sfx = 0
  let kits = 0
  let uploads = 0
  const raw = new Map<string, number>()
  for (const entry of entries) {
    if (entry.type === 'multisample note') continue
    const loop = isLoopEntry(entry)
    const shot = isOneShotEntry(entry)
    const effect = isSfxEntry(entry)
    const kit = isDrumKitEntry(entry)
    const upload = isUploadEntry(entry)
    if (loop) loops += 1
    if (shot) shots += 1
    if (effect) sfx += 1
    if (kit) kits += 1
    if (upload) uploads += 1
    if (!loop && !shot && !effect && !kit && !upload && entry.type) {
      raw.set(entry.type, (raw.get(entry.type) ?? 0) + 1)
    }
  }
  kits += instruments.filter((item) => isDrumKitInstrument(item)).length
  const choices: ContentTypeChoice[] = []
  if (loops) choices.push({ id: 'loop', label: 'Loops' })
  if (shots) choices.push({ id: 'one-shot', label: 'One-shots' })
  if (instruments.length) choices.push({ id: 'instrument', label: 'Instruments' })
  if (kits) choices.push({ id: 'drum-kit', label: 'Drum kits' })
  if (sfx) choices.push({ id: 'sfx', label: 'SFX' })
  if (uploads) choices.push({ id: 'upload', label: 'My Library uploads' })
  for (const id of [...raw.keys()].sort((a, b) => a.localeCompare(b))) {
    choices.push({ id, label: contentTypeLabel(id) })
  }
  return choices
}
