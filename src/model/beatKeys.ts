import { padFaceName } from '../instruments/pads/record'
import { BANKS, padVelocity, type PadProgram } from './padMachine'

/** On-screen keys start at C3. One octave is twelve keys. */
export const BEAT_KEY_BASE = 48

export interface BeatPad {
  pitch: number
  name: string
}

export interface BeatKey {
  bank: number
  index: number
  pitch: number
  name: string
}

/** Sixteen pads per bank, twelve keys per octave, starting at the current bank. */
export function beatKeyAt(kit: Pick<PadProgram, 'activeBank' | 'banks'>, octave: number, step: number): BeatKey | null {
  if (!Number.isInteger(step) || step < 0 || step > 11) return null
  const banks = kit.banks.length
  if (!banks) return null
  const slot = kit.activeBank * 16 + octave * 12 + step
  if (slot < 0 || slot >= banks * 16) return null
  const bank = Math.floor(slot / 16)
  const index = slot % 16
  const pad = kit.banks[bank]?.[index]
  if (!pad) return null
  return { bank, index, pitch: pad.pitch, name: padFaceName(pad) }
}

/** The dock pitch is C3 plus the octave and the chromatic step. */
export function beatKeyForPitch(kit: Pick<PadProgram, 'activeBank' | 'banks'>, keyboardPitch: number): BeatKey | null {
  const relative = Math.round(keyboardPitch) - BEAT_KEY_BASE
  const octave = Math.floor(relative / 12)
  const step = relative - octave * 12
  return beatKeyAt(kit, octave, step)
}

export function beatOctaveHasPads(kit: Pick<PadProgram, 'activeBank' | 'banks'>, octave: number): boolean {
  for (let step = 0; step < 12; step++) if (beatKeyAt(kit, octave, step)) return true
  return false
}

/** Bank letters covered by this octave, such as "Bank A" or "Bank A–B". */
export function beatPageLabel(kit: Pick<PadProgram, 'activeBank' | 'banks'>, octave: number): string {
  let first: BeatKey | null = null
  let last: BeatKey | null = null
  for (let step = 0; step < 12; step++) {
    const key = beatKeyAt(kit, octave, step)
    if (!key) continue
    if (!first) first = key
    last = key
  }
  if (!first || !last) return 'Pads'
  const start = BANKS[first.bank] ?? String(first.bank + 1)
  const end = BANKS[last.bank] ?? String(last.bank + 1)
  return start === end ? `Bank ${start}` : `Bank ${start}–${end}`
}

export function beatKeyVelocity(played: number, fullLevel: boolean): number {
  return padVelocity(played, fullLevel, false)
}

export function isBeatMachineInstrument(instrument: string | undefined): boolean {
  return instrument === 'pads' || instrument === 'drum-machine'
}

export interface BeatHit {
  trackId: string
  pitch: number
  velocity: number
  name: string
}

/** Null when this track is not a beat machine. A hit with pitch -1 is a key with no pad. */
export function beatHitForTrack(
  track: { id: string; instrument?: string; padKit?: PadProgram } | null | undefined,
  keyboardPitch: number,
  velocity: number,
): BeatHit | null {
  if (!track || !isBeatMachineInstrument(track.instrument) || !track.padKit) return null
  const key = beatKeyForPitch(track.padKit, keyboardPitch)
  if (!key) return { trackId: track.id, pitch: -1, velocity: 0, name: '' }
  return {
    trackId: track.id,
    pitch: key.pitch,
    velocity: beatKeyVelocity(velocity, track.padKit.fullLevel),
    name: key.name,
  }
}
