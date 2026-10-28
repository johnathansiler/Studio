/** Close position, inversions, drop voicings, and voice leading. */

export type VoicingId = 'close' | 'drop2' | 'drop3' | 'drop24' | 'spread' | 'shell'

export interface VoicingOptions {
  inversion?: number
  spread?: boolean
  drop2?: boolean
  drop3?: boolean
  drop24?: boolean
  shell?: boolean
  octave?: boolean
  voiceLead?: boolean
  previous?: number[]
  voicing?: VoicingId
}

export function voiceNotes(pitchClassesOrMidi: number[], options: VoicingOptions = {}): number[] {
  const flags = { ...options, ...flagsFor(options.voicing) }
  const raw = pitchClassesOrMidi.map(soften)
  const looksMidi = raw.some((pitch) => pitch > 24)
  let notes = (looksMidi ? raw : raw.map((pc) => 60 + pitchClass(pc))).sort((a, b) => a - b)
  notes = unique(notes)
  const inversion = Math.max(0, flags.inversion ?? 0) % Math.max(1, notes.length)
  notes = invert(notes, inversion)
  if (flags.shell && notes.length >= 4) {
    const sorted = [...notes].sort((a, b) => a - b)
    notes = [sorted[0], sorted[1], sorted[sorted.length - 1]]
  }
  if (flags.spread && notes.length > 2) notes = notes.map((pitch, index) => (index === 1 ? pitch + 12 : pitch)).sort((a, b) => a - b)
  if (flags.drop2 && notes.length > 2) notes = dropFromTop(notes, 2)
  if (flags.drop3 && notes.length > 3) notes = dropFromTop(notes, 3)
  if (flags.drop24 && notes.length > 3) {
    notes = dropFromTop(notes, 2)
    notes = dropFromTop(notes, 4)
  }
  if (flags.octave) {
    const root = Math.min(...notes)
    notes = unique([...notes, root + 12]).sort((a, b) => a - b)
  }
  if (flags.voiceLead && flags.previous && flags.previous.length) notes = leadVoices(notes, flags.previous)
  return notes
}

export function movement(a: number[], b: number[]) {
  return matchCost(a, b)
}

function flagsFor(voicing: VoicingId | undefined): VoicingOptions {
  if (voicing === 'drop2') return { drop2: true }
  if (voicing === 'drop3') return { drop3: true }
  if (voicing === 'drop24') return { drop24: true }
  if (voicing === 'spread') return { spread: true }
  if (voicing === 'shell') return { shell: true }
  return {}
}

function dropFromTop(notes: number[], place: number) {
  const sorted = [...notes].sort((a, b) => a - b)
  const index = sorted.length - place
  if (index < 0) return sorted
  const target = sorted[index]
  return sorted.map((pitch) => (pitch === target ? pitch - 12 : pitch)).sort((a, b) => a - b)
}

function invert(notes: number[], times: number) {
  let next = [...notes]
  for (let i = 0; i < times; i++) {
    const bass = next[0]
    next = [...next.slice(1), bass + 12]
  }
  return next
}

function leadVoices(target: number[], previous: number[]) {
  let best = target
  let bestCost = Infinity
  const span = Math.max(1, target.length)
  for (let inv = 0; inv < span; inv++) {
    const inverted = invert([...target].sort((a, b) => a - b), inv)
    for (const shift of [-12, 0, 12]) {
      const candidate = inverted.map((pitch) => pitch + shift).sort((a, b) => a - b)
      const cost = matchCost(candidate, previous)
      if (cost < bestCost) {
        bestCost = cost
        best = candidate
      }
    }
  }
  return best
}

function matchCost(candidate: number[], previous: number[]) {
  const used = new Set<number>()
  let cost = 0
  for (const pitch of candidate) {
    let best = 99
    let index = -1
    previous.forEach((other, i) => {
      if (used.has(i)) return
      const dist = Math.abs(other - pitch)
      if (dist < best) {
        best = dist
        index = i
      }
    })
    if (index >= 0) used.add(index)
    cost += index >= 0 ? best : 12
  }
  return cost
}

function unique(notes: number[]) {
  return [...new Set(notes)]
}

function soften(pitch: number) {
  if (!Number.isFinite(pitch)) return 0
  const nearest = Math.round(pitch)
  return Math.abs(pitch - nearest) < 1e-6 ? nearest : pitch
}

function pitchClass(pitch: number) {
  return ((Math.round(pitch) % 12) + 12) % 12
}
