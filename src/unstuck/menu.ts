import type { SongContext, Suggestion, SuggestionKind } from './types'

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

function action(key: string, group: UnstuckAction['group'], title: string, items: Suggestion[], context: SongContext, pass: number): UnstuckAction | null {
  if (!items.length) return null
  const item = items[pass % items.length]
  return { key, group, title, detail: actionDetail(item, context), items }
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
