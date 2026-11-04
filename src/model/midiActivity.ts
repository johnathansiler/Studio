/** A note that should light a track's MIDI indicator between two audio-clock times. */
export interface MidiMark {
  id: string
  from: number
  until: number
}

/** Which tracks have a note sounding at `now`. Held keys stay lit after their mark. */
export function midiLit(marks: readonly MidiMark[], held: ReadonlySet<string>, now: number): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id of held) out[id] = true
  for (const mark of marks) {
    if (now >= mark.from - 0.02 && now <= mark.until) out[mark.id] = true
  }
  return out
}

/** Drop marks that finished a little while ago. */
export function pruneMidiMarks(marks: readonly MidiMark[], now: number): MidiMark[] {
  return marks.filter((mark) => mark.until >= now - 0.05)
}
