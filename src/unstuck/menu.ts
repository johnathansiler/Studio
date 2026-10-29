import type { ArrangementOp, SongContext, Suggestion, SuggestionKind, SuggestionNote, SuggestionPart } from './types'

export interface UnstuckAction {
  key: string
  group: 'Start a song' | 'Add a part' | 'Change it up'
  title: string
  /** What this tap will write, and where. */
  detail: string
  items: Suggestion[]
}

const GROUPS = {
  start: 'Start a song',
  add: 'Add a part',
  change: 'Change it up',
} as const

function barOf(item: Suggestion, context: SongContext) {
  return Math.floor(item.startBeat / Math.max(1, context.beatsPerBar)) + 1
}

function namesFor(item: Suggestion, context: SongContext): string {
  const roles = new Set<string>()
  for (const part of item.parts) {
    if (part.write === false || !part.notes.length) continue
    roles.add(part.role === 'fill' ? 'drums' : part.role)
  }
  for (const role of item.arrangement?.dropRoles ?? []) roles.add(role)
  if (item.arrangement?.replaceDrums || item.arrangement?.dropPitches?.length) roles.add('drums')
  if (!roles.size) return 'the song'
  return [...roles].map((role) => {
    const found = context.tracks.find((track) => track.role === role && !track.muted)
    if (found) return found.name
    return role === 'chords' ? 'Chords' : role.charAt(0).toUpperCase() + role.slice(1)
  }).join(' and ')
}

export function actionDetail(item: Suggestion, context: SongContext): string {
  return `${item.why} On ${namesFor(item, context)}, bar ${barOf(item, context)}.`
}

function varyNotes(notes: SuggestionNote[], pass: number): { notes: SuggestionNote[]; line: string } {
  if (notes.length >= 3 && pass === 1) {
    const kept = notes.filter((_, index) => index % 2 === 0)
    return {
      notes: kept.map((note) => ({ ...note, velocity: Math.min(1, Math.round((note.velocity + 0.08) * 100) / 100) })),
      line: 'This pass keeps every other note.',
    }
  }
  if (pass === 1) {
    return {
      notes: notes.map((note) => ({ ...note, velocity: Math.min(1, Math.round((note.velocity + 0.12) * 100) / 100) })),
      line: 'This pass is louder.',
    }
  }
  return {
    notes: notes.map((note) => ({
      ...note,
      startBeat: Math.round((note.startBeat + 0.25) * 100) / 100,
      velocity: Math.max(0.15, Math.round((note.velocity - 0.05) * 100) / 100),
    })),
    line: 'This pass lands a sixteenth later.',
  }
}

/** A second or third tap of a one-idea card. The notes, or the bar it lands on, change. */
export function varySuggestion(item: Suggestion, pass: number, beatsPerBar: number): Suggestion {
  if (pass <= 0) return item
  const writable = item.parts.some((part) => part.write !== false && part.notes.length > 0)
  if (!writable) {
    const bars = pass === 1 ? 'the next bar' : 'two bars later'
    return {
      ...item,
      id: `${item.id}~${pass}`,
      startBeat: item.startBeat + pass * Math.max(1, beatsPerBar),
      why: `${item.why} This pass starts ${bars}.`,
    }
  }
  let line = ''
  const parts: SuggestionPart[] = item.parts.map((part) => {
    if (part.write === false || !part.notes.length) return part
    const next = varyNotes(part.notes, pass)
    line = next.line
    return { ...part, notes: next.notes }
  })
  const arrangement: ArrangementOp | undefined = item.arrangement
  return {
    ...item,
    id: `${item.id}~${pass}`,
    why: line ? `${item.why} ${line}` : item.why,
    parts,
    arrangement,
  }
}

function choicesFor(items: Suggestion[], beatsPerBar: number): Suggestion[] {
  if (items.length > 1) return items
  return [items[0], varySuggestion(items[0], 1, beatsPerBar), varySuggestion(items[0], 2, beatsPerBar)]
}

function action(key: string, group: UnstuckAction['group'], title: string, items: Suggestion[], context: SongContext, pass: number): UnstuckAction | null {
  if (!items.length) return null
  const choices = choicesFor(items, context.beatsPerBar)
  const item = choices[pass % choices.length]
  return { key, group, title, detail: actionDetail(item, context), items: choices }
}

/** One card per thing Unstuck can do. `pass` picks which variation the next tap writes. */
export function unstuckActions(items: Suggestion[], context: SongContext, pass: Record<string, number> = {}): UnstuckAction[] {
  const of = (kind: SuggestionKind) => items.filter((item) => item.kind === kind)
  const arrangement = of('arrangement')
  const adds = arrangement.filter((item) => item.id.startsWith('arrange-add'))
  const changes = arrangement.filter((item) => !item.id.startsWith('arrange-add'))
  const empty = context.contentEndBeat <= 0 && context.chordsByBar.length === 0
  const chordGroup = empty ? GROUPS.start : GROUPS.add
  const built = [
    action('chords', chordGroup, 'Next chords', of('progression'), context, pass.chords ?? 0),
    action('section', empty ? GROUPS.start : GROUPS.add, 'Next section', of('section'), context, pass.section ?? 0),
    action('melody', GROUPS.add, 'Chords for the melody', of('harmonize'), context, pass.melody ?? 0),
    ...adds.map((item) => action(item.id, GROUPS.add, item.title, [item], context, 0)),
    ...of('transition').map((item) => action(item.id, GROUPS.change, item.title, [item], context, 0)),
    ...changes.map((item) => action(item.id, GROUPS.change, item.title, [item], context, 0)),
  ]
  return built.filter((item): item is UnstuckAction => item != null)
}

export const UNSTUCK_GROUPS: UnstuckAction['group'][] = [GROUPS.start, GROUPS.add, GROUPS.change]
