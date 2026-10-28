/** Ranked suggestions from transition weights, section form, and the local progression library. */

import { PROGRESSIONS, type Mode } from '../model/progressions'
import { NOTE_NAMES, pitchClass } from '../model/scale'
import { currentSection, editSpan, landingBeat, normalizeSongContext, recentSymbols } from './context'
import {
  bedParts,
  fillNotes,
  grooveFor,
  halfTimeDrums,
  pickupNotes,
  renderHarmony,
  riserNotes,
  symbolsInSpan,
} from './render'
import {
  cadenceScore,
  degreeKey,
  moveWhy,
  nextWeights,
  progressionWhy,
  romanLine,
  sameChords,
  sectionSymbols,
  sectionTitle,
  sectionWeights,
  sectionWhy,
  tonic,
} from './theory'
import type { MelodyNote, SongContext, SongContextInput, Suggestion, SuggestionKind, SuggestionPart } from './types'

interface Path {
  symbols: string[]
  score: number
}

interface ChordChoice {
  symbol: string
  pcs: number[]
}

const MOVE_TITLE: Record<string, string> = {
  'I>V': 'Ask the V',
  'I>IV': 'Open on IV',
  'I>vi': 'Soften to vi',
  'I>ii': 'Step to ii',
  'I>bVII': 'Flat seventh',
  'I>iii': 'Through iii',
  'ii>V': 'Into the V',
  'IV>V': 'Lift to V',
  'IV>I': 'Fall to I',
  'IV>iv': 'Borrow iv',
  'V>I': 'Resolve home',
  'V>vi': 'Deceptive vi',
  'V>i': 'Resolve to i',
  'vi>IV': 'Lift the vi',
  'vi>V': 'Aim at V',
  'i>VI': 'Major VI',
  'i>VII': 'Climb to VII',
  'i>iv': 'To the iv',
  'i>V': 'Leading tone',
  'i>III': 'Relative major',
  'VII>i': 'Back to i',
  'VI>VII': 'Keep climbing',
  'iv>i': 'Minor plagal',
  'iv>V': 'Raise the V',
}

const MAJOR_TRIADS: ChordChoice[] = [
  { symbol: 'I', pcs: [0, 4, 7] },
  { symbol: 'ii', pcs: [2, 5, 9] },
  { symbol: 'iii', pcs: [4, 7, 11] },
  { symbol: 'IV', pcs: [5, 9, 0] },
  { symbol: 'V', pcs: [7, 11, 2] },
  { symbol: 'vi', pcs: [9, 0, 4] },
]
const MAJOR_SEVENTHS: ChordChoice[] = [
  { symbol: 'Imaj7', pcs: [0, 4, 7, 11] },
  { symbol: 'ii7', pcs: [2, 5, 9, 0] },
  { symbol: 'iii7', pcs: [4, 7, 11, 2] },
  { symbol: 'IVmaj7', pcs: [5, 9, 0, 4] },
  { symbol: 'V7', pcs: [7, 11, 2, 5] },
  { symbol: 'vi7', pcs: [9, 0, 4, 7] },
]
const MAJOR_BORROWED: ChordChoice[] = [
  { symbol: 'iv', pcs: [5, 8, 0] },
  { symbol: 'bVII', pcs: [10, 2, 5] },
  { symbol: 'bVI', pcs: [8, 0, 3] },
]
const MINOR_TRIADS: ChordChoice[] = [
  { symbol: 'i', pcs: [0, 3, 7] },
  { symbol: 'III', pcs: [3, 7, 10] },
  { symbol: 'iv', pcs: [5, 8, 0] },
  { symbol: 'v', pcs: [7, 10, 2] },
  { symbol: 'V', pcs: [7, 11, 2] },
  { symbol: 'VI', pcs: [8, 0, 3] },
  { symbol: 'VII', pcs: [10, 2, 5] },
]
const MINOR_SEVENTHS: ChordChoice[] = [
  { symbol: 'i7', pcs: [0, 3, 7, 10] },
  { symbol: 'iv7', pcs: [5, 8, 0, 3] },
  { symbol: 'V7', pcs: [7, 11, 2, 5] },
  { symbol: 'VImaj7', pcs: [8, 0, 3, 7] },
  { symbol: 'VII7', pcs: [10, 2, 5, 8] },
]

export function suggest(input: SongContextInput): Suggestion[] {
  const context = normalizeSongContext(input)
  return [
    ...suggestProgressions(context),
    ...suggestSections(context),
    ...suggestTransitions(context),
    ...suggestArrangement(context),
    ...suggestHarmonizations(context),
  ]
}

export function suggestionsFor(input: SongContextInput, kind: SuggestionKind): Suggestion[] {
  return suggest(input).filter((item) => item.kind === kind)
}

function suggestProgressions(context: SongContext): Suggestion[] {
  const recent = recentSymbols(context)
  const last = recent.at(-1) ?? ''
  const from = last || 'V'
  const mode = context.mode
  const paths = [...beam(from, mode), ...libraryPaths(from, mode, context.tempo)]
  for (const path of paths) path.score -= repeatPenalty(path.symbols, recent)
  const picked = pickDiverse(paths, 3)
  const used = new Set<string>()
  const start = landingBeat(context)
  return picked.map((path) => {
    const line = romanLine(path.symbols)
    const title = progressionTitle(last || tonic(mode), path.symbols, used)
    return {
      id: `prog-${slug(line)}`,
      kind: 'progression' as const,
      title,
      why: progressionLead(last, path.symbols, mode, context.contentEndBeat > 0 || context.activeRoles.length > 0),
      line,
      startBeat: start,
      bars: path.symbols.length,
      parts: renderHarmony(path.symbols, mode, context.key, context.beatsPerBar, 'chords'),
      hear: 'continue' as const,
    }
  })
}

function suggestSections(context: SongContext): Suggestion[] {
  const from = currentSection(context)
  const recent = recentSymbols(context)
  const start = landingBeat(context)
  const ranked = [...sectionWeights(from)].sort((a, b) => b[1] - a[1])
  const out: Suggestion[] = []
  for (const [kind] of ranked) {
    if (out.length >= 3) break
    const symbols = sectionSymbols(kind, context.mode, recent)
    out.push({
      id: `section-${kind}`,
      kind: 'section',
      title: sectionTitle(kind),
      why: sectionWhy(from, kind),
      line: romanLine(symbols),
      startBeat: start,
      bars: symbols.length,
      parts: renderHarmony(symbols, context.mode, context.key, context.beatsPerBar, 'band', grooveFor(context.tempo, context.mode, kind)),
      hear: 'continue',
    })
  }
  return out
}

function suggestTransitions(context: SongContext): Suggestion[] {
  const bar = context.beatsPerBar
  const landing = landingBeat(context)
  const into = landing > 0 ? landing - bar : 0
  const relative = context.mode === 'major'
    ? { key: (context.key + 9) % 12, mode: 'minor' as const, scale: 'aeolian', pivot: 'vi', next: ['V', 'i'] }
    : { key: (context.key + 3) % 12, mode: 'major' as const, scale: 'ionian', pivot: 'III', next: ['V', 'I'] }
  const pivot = renderHarmony([relative.pivot], context.mode, context.key, bar, 'chords')
  const destination = renderHarmony(relative.next, relative.mode, relative.key, bar, 'chords')
  const destName = `${NOTE_NAMES[relative.key]}${relative.mode === 'minor' ? 'm' : ''}`
  const borrowed = context.mode === 'major' ? ['IV', 'iv', 'I'] : ['i', 'IV', 'V', 'i']
  const rise = riserNotes(context.key, context.mode, bar)
  return [
    {
      id: 'move-fill',
      kind: 'transition',
      title: 'Fill',
      why: 'The snare thickens on the last beats so the next bar feels like an arrival.',
      line: 'Snare fill',
      startBeat: into,
      bars: 1,
      parts: [{ role: 'fill', notes: fillNotes(bar) }],
      hear: 'continue',
    },
    {
      id: 'move-riser',
      kind: 'transition',
      title: 'Riser',
      why: 'A rising line and an open-hat roll hand the downbeat to the next section.',
      line: 'Riser',
      startBeat: into,
      bars: 1,
      parts: [
        { role: 'melody', notes: rise.line },
        { role: 'fill', notes: rise.drums },
      ],
      hear: 'continue',
    },
    {
      id: 'move-pickup',
      kind: 'transition',
      title: 'Pickup',
      why: 'Three scale tones lead into the next downbeat without a new chord.',
      line: 'Pickup',
      startBeat: into,
      bars: 1,
      parts: [{ role: 'melody', notes: pickupNotes(context.key, context.mode, bar) }],
      hear: 'continue',
    },
    {
      id: 'move-modulation',
      kind: 'transition',
      title: 'Modulate',
      why: context.mode === 'major'
        ? `${destName} is already vi here, so it can become i, and its V confirms the new key.`
        : `${destName} is already III here, so it can become I, and its V confirms the new key.`,
      line: `${relative.pivot} → ${relative.next.join('–')} in ${destName}`,
      startBeat: landing,
      bars: 1 + relative.next.length,
      parts: concatParts(pivot, destination, bar),
      modulation: { key: relative.key, mode: relative.mode, scale: relative.scale },
      hear: 'continue',
    },
    {
      id: 'move-borrowed',
      kind: 'transition',
      title: 'Borrowed chord',
      why: context.mode === 'major'
        ? 'iv borrows the minor four from the parallel minor, then resolves to I.'
        : 'IV and V are the major forms borrowed from the parallel major, and V leads home.',
      line: romanLine(borrowed),
      startBeat: landing,
      bars: borrowed.length,
      parts: renderHarmony(borrowed, context.mode, context.key, bar, 'chords'),
      hear: 'continue',
    },
  ]
}

function suggestArrangement(context: SongContext): Suggestion[] {
  const bar = context.beatsPerBar
  const span = editSpan(context)
  const home = tonic(context.mode)
  const startBar = Math.round(span.start / bar)
  const symbols = symbolsInSpan(context.chordsByBar, startBar, span.bars, recentSymbols(context).at(-1) || home)
  const bed = bedParts(symbols, context.mode, context.key, bar)
  const hasDrums = context.activeRoles.includes('drums')
  const groove = grooveFor(context.tempo, context.mode, 'chorus')
  const items: Suggestion[] = []
  if (hasDrums) {
    items.push({
      id: 'arrange-drop',
      kind: 'arrangement',
      title: 'Drop the drums',
      why: 'The drums leave for these bars so the harmony can sit forward.',
      line: 'Drums out',
      startBeat: span.start,
      bars: span.bars,
      parts: bed,
      arrangement: { dropRoles: ['drums'] },
      hear: 'arrange',
    })
  } else {
    const drums = renderHarmony(symbols, context.mode, context.key, bar, 'band', groove).find((part) => part.role === 'drums')
    items.push({
      id: 'arrange-add-drums',
      kind: 'arrangement',
      title: 'Add drums',
      why: 'A plain backbeat gives the chords something to sit on.',
      line: 'Backbeat',
      startBeat: span.start,
      bars: span.bars,
      parts: drums ? [drums, ...bed] : bed,
      hear: 'arrange',
    })
  }
  if (!context.activeRoles.includes('bass')) {
    const bass = renderHarmony(symbols, context.mode, context.key, bar, 'chords').find((part) => part.role === 'bass')
    items.push({
      id: 'arrange-add-bass',
      kind: 'arrangement',
      title: 'Add bass',
      why: 'The bass plays the root of each chord so the changes read clearly.',
      line: 'Bass roots',
      startBeat: span.start,
      bars: span.bars,
      parts: bass ? [bass, ...bed.filter((part) => part.role !== 'bass')] : bed,
      hear: 'arrange',
    })
  } else {
    const pad = renderHarmony(symbols, context.mode, context.key, bar, 'pad')
    items.push({
      id: 'arrange-add-pad',
      kind: 'arrangement',
      title: 'Add a pad',
      why: 'A held pad doubles the chords an octave up and fills the gap.',
      line: 'Pad',
      startBeat: span.start,
      bars: span.bars,
      parts: [...pad, ...bed],
      hear: 'arrange',
    })
  }
  items.push({
    id: 'arrange-half',
    kind: 'arrangement',
    title: 'Half-time',
    why: hasDrums
      ? 'The snare moves to the middle of the bar, so the same tempo feels half as fast.'
      : 'A half-time beat lands under these bars, with the snare in the middle of the bar.',
    line: 'Half-time',
    startBeat: span.start,
    bars: span.bars,
    parts: [{ role: 'drums', notes: halfTimeDrums(span.bars, bar) }, ...bed],
    arrangement: { replaceDrums: true },
    hear: 'arrange',
  })
  const held = renderHarmony([symbols[0] || home], context.mode, context.key, bar, 'pad')
  const hats = sparseHats(span.bars, bar)
  items.push({
    id: 'arrange-break',
    kind: 'arrangement',
    title: 'Breakdown',
    why: 'Hats and a held chord stay. The kick and snare sit out.',
    line: 'Breakdown',
    startBeat: span.start,
    bars: span.bars,
    parts: [...stretchPad(held, span.bars, bar), { role: 'drums', notes: hats }, ...bed],
    arrangement: { dropPitches: [35, 36, 38, 40] },
    hear: 'arrange',
  })
  return items
}

function suggestHarmonizations(context: SongContext): Suggestion[] {
  if (!context.melodyNotes.length) return []
  const bar = context.beatsPerBar
  const groups = melodyBars(context.melodyNotes, bar)
  const first = groups[0]?.index ?? 0
  const last = groups.at(-1)?.index ?? first
  const start = first * bar
  const bars = last - first + 1
  const passes: { id: string; title: string; why: string; choices: ChordChoice[]; common: number }[] = [
    {
      id: 'harm-triad',
      title: 'Chord tones',
      why: 'Each chord keeps the strongest melody note, and the last bar cadences home.',
      choices: context.mode === 'minor' ? MINOR_TRIADS : MAJOR_TRIADS,
      common: 0.25,
    },
    {
      id: 'harm-sevenths',
      title: 'With sevenths',
      why: 'Sevenths catch more of the melody and share tones with the chord before them.',
      choices: context.mode === 'minor' ? MINOR_SEVENTHS : MAJOR_SEVENTHS,
      common: 0.45,
    },
    {
      id: 'harm-color',
      title: 'With color',
      why: context.mode === 'major'
        ? 'A borrowed iv, bVI, or bVII is allowed where it catches the melody.'
        : 'The major V is allowed where the melody wants a leading tone.',
      choices: context.mode === 'minor' ? MINOR_TRIADS : [...MAJOR_TRIADS, ...MAJOR_BORROWED],
      common: 0.2,
    },
  ]
  const seen = new Set<string>()
  const melodyPart: SuggestionPart = {
    role: 'melody',
    write: false,
    notes: context.melodyNotes
      .filter((note) => note.startBeat >= start - 1e-6 && note.startBeat < start + bars * bar)
      .map((note) => ({
        pitch: note.pitch,
        startBeat: note.startBeat - start,
        durationBeats: note.durationBeats,
        velocity: note.velocity ?? 0.7,
      })),
  }
  const out: Suggestion[] = []
  for (const pass of passes) {
    const symbols = harmonizeBars(groups, first, bars, context, pass.choices, pass.common)
    const line = romanLine(symbols)
    if (seen.has(line)) continue
    seen.add(line)
    const harmony = renderHarmony(symbols, context.mode, context.key, bar, 'chords')
    out.push({
      id: pass.id,
      kind: 'harmonize',
      title: pass.title,
      why: pass.why,
      line,
      startBeat: start,
      bars,
      parts: [...harmony, melodyPart],
      hear: 'arrange',
    })
  }
  return out
}

function harmonizeBars(groups: { index: number; notes: MelodyNote[] }[], first: number, bars: number, context: SongContext, choices: ChordChoice[], common: number): string[] {
  const symbols: string[] = []
  let prev: ChordChoice | null = null
  for (let offset = 0; offset < bars; offset++) {
    const index = first + offset
    const notes = groups.find((group) => group.index === index)?.notes ?? []
    const lastBar = offset === bars - 1
    const penultimate = offset === bars - 2
    const home = tonic(context.mode)
    const prefer = lastBar ? [home] : penultimate ? ['V', 'v'] : []
    const boost = lastBar ? 1.15 : penultimate ? 0.7 : 0
    let best = choices[0]
    let bestScore = -Infinity
    for (const choice of choices) {
      const score = chordScore(choice, notes, context.key, index * context.beatsPerBar, prev, common, prefer, boost)
      if (score > bestScore) {
        best = choice
        bestScore = score
      }
    }
    symbols.push(best.symbol)
    prev = best
  }
  return symbols
}

function chordScore(choice: ChordChoice, notes: MelodyNote[], key: number, barStart: number, prev: ChordChoice | null, commonWeight: number, prefer: string[], boost: number): number {
  let covered = 0
  let total = 0
  let strong = notes[0]
  let strongWeight = -1
  for (const note of notes) {
    const downbeat = note.startBeat <= barStart + 0.2 && note.startBeat + note.durationBeats > barStart + 0.02
    const weight = Math.max(0.1, note.durationBeats) * (downbeat ? 2 : 1)
    total += weight
    if (choice.pcs.includes(pitchClass(note.pitch - key))) covered += weight
    if (weight > strongWeight) {
      strong = note
      strongWeight = weight
    }
  }
  let score = total ? (covered / total) * 5 : 0.15
  if (strong && notes.length) {
    const rel = pitchClass(strong.pitch - key)
    if (rel === choice.pcs[0]) score += 0.45
    else if (rel === choice.pcs[1]) score += 0.3
  }
  if (prev) {
    score += choice.pcs.filter((pc) => prev.pcs.includes(pc)).length * commonWeight
    const motion = (choice.pcs[0] - prev.pcs[0] + 12) % 12
    if (motion === 5 || motion === 7) score += 0.35
    if (degreeKey(choice.symbol) === degreeKey(prev.symbol)) score -= 0.3
  }
  if (prefer.includes(degreeKey(choice.symbol))) score += boost
  return score
}

function melodyBars(notes: MelodyNote[], beatsPerBar: number): { index: number; notes: MelodyNote[] }[] {
  const map = new Map<number, MelodyNote[]>()
  for (const note of notes) {
    const index = Math.max(0, Math.floor((note.startBeat + 1e-6) / beatsPerBar))
    const list = map.get(index) ?? []
    list.push(note)
    map.set(index, list)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([index, group]) => ({ index, notes: group }))
}

function beam(from: string, mode: Mode): Path[] {
  let paths: Path[] = [{ symbols: [], score: 0 }]
  for (let step = 0; step < 4; step++) {
    const next: Path[] = []
    for (const path of paths) {
      const prev = path.symbols.at(-1) ?? from
      for (const [symbol, weight] of nextWeights(prev, mode)) {
        const symbols = [...path.symbols, symbol]
        const score = path.score + Math.log(weight)
        next.push({ symbols, score })
      }
    }
    next.sort((a, b) => finishScore(b, mode) - finishScore(a, mode))
    const seen = new Set<string>()
    paths = []
    for (const path of next) {
      const key = path.symbols.map(degreeKey).join('|')
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(path)
      if (paths.length === 8) break
    }
  }
  return paths.map((path) => ({ symbols: path.symbols, score: finishScore(path, mode) }))
}

function libraryPaths(from: string, mode: Mode, tempo: number): Path[] {
  const out: Path[] = []
  for (const item of PROGRESSIONS) {
    if (item.mode !== mode) continue
    if (item.chords.length < 2 || item.chords.length > 4) continue
    const symbols = item.chords.map((chord) => chord.symbol)
    const first = weightOf(from, symbols[0], mode)
    if (first <= 0) continue
    let logSum = Math.log(first)
    for (let index = 1; index < symbols.length; index++) {
      const weight = weightOf(symbols[index - 1], symbols[index], mode)
      logSum += Math.log(weight || 0.35)
    }
    const score = logSum / symbols.length + cadenceScore(symbols, mode) + 0.12 - Math.min(0.35, Math.abs(item.tempo - tempo) / 200)
    out.push({ symbols, score })
  }
  return out
}

function weightOf(from: string, to: string, mode: Mode): number {
  const want = degreeKey(to)
  return nextWeights(from, mode).find(([symbol]) => degreeKey(symbol) === want)?.[1] ?? 0
}

function repeatPenalty(symbols: string[], recent: string[]): number {
  if (!recent.length || !symbols.length) return 0
  if (sameChords(symbols, recent.slice(-symbols.length)) && symbols.length <= recent.length) {
    const tail = recent.slice(-symbols.length).map(degreeKey).join('|')
    if (tail === symbols.map(degreeKey).join('|')) return 5
  }
  return 0
}

function pickDiverse(paths: Path[], count: number): Path[] {
  const sorted = [...paths].sort((a, b) => b.score - a.score)
  const picked: Path[] = []
  const used = new Set<string>()
  const take = (requireNewFirst: boolean) => {
    for (const path of sorted) {
      if (picked.length >= count) return
      const key = path.symbols.map(degreeKey).join('|')
      if (used.has(key)) continue
      const first = degreeKey(path.symbols[0] || '')
      if (requireNewFirst && picked.some((item) => degreeKey(item.symbols[0] || '') === first)) continue
      picked.push(path)
      used.add(key)
    }
  }
  take(true)
  take(false)
  if (!picked.length) picked.push({ symbols: ['I', 'V', 'vi', 'IV'], score: 0 })
  return picked.slice(0, count)
}

function finishScore(path: Path, mode: Mode): number {
  if (!path.symbols.length) return path.score
  return path.score / path.symbols.length + cadenceScore(path.symbols, mode)
}

function progressionLead(last: string, symbols: string[], mode: Mode, hasMusic: boolean): string {
  if (last) return progressionWhy(last, symbols, mode)
  const start = degreeKey(symbols[0] || tonic(mode))
  if (hasMusic) return `No chords yet, so this starts on ${start} in the project key.`
  return `Nothing is written yet, so this starts on ${start}.`
}

function progressionTitle(from: string, symbols: string[], used: Set<string>): string {
  const key = `${degreeKey(from)}>${degreeKey(symbols[0] || '')}`
  let title = MOVE_TITLE[key] || moveWhy(from, symbols[0] || from, 'major').split(' ')[0] || romanLine(symbols)
  if (!MOVE_TITLE[key]) title = romanLine(symbols)
  if (used.has(title)) title = romanLine(symbols)
  if (used.has(title)) title = `${romanLine(symbols)} ${used.size + 1}`
  used.add(title)
  return title
}

function concatParts(head: SuggestionPart[], tail: SuggestionPart[], shift: number): SuggestionPart[] {
  const roles = new Map<string, SuggestionPart>()
  const push = (part: SuggestionPart, offset: number) => {
    const notes = part.notes.map((note) => ({ ...note, startBeat: note.startBeat + offset }))
    const existing = roles.get(part.role)
    if (existing) existing.notes.push(...notes)
    else roles.set(part.role, { role: part.role, write: part.write, notes })
  }
  for (const part of head) push(part, 0)
  for (const part of tail) push(part, shift)
  return [...roles.values()]
}

function sparseHats(bars: number, beatsPerBar: number): { pitch: number; startBeat: number; durationBeats: number; velocity: number }[] {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    notes.push({ pitch: 42, startBeat: bar * beatsPerBar, durationBeats: 0.12, velocity: 0.32 })
    notes.push({ pitch: 42, startBeat: bar * beatsPerBar + beatsPerBar / 2, durationBeats: 0.12, velocity: 0.28 })
  }
  return notes
}

function stretchPad(parts: SuggestionPart[], bars: number, beatsPerBar: number): SuggestionPart[] {
  return parts.map((part) => ({
    ...part,
    notes: part.notes.map((note) => ({ ...note, durationBeats: Math.max(note.durationBeats, bars * beatsPerBar - 0.05) })),
  }))
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'idea'
}
