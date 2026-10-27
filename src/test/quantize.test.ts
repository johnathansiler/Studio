import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject, type MidiNote } from '../model/types'
import { emptyCell, starterPattern } from '../model/steps'
import {
  defaultQuantize,
  detectTransients,
  extractGroove,
  mpcGroove,
  quantizeAudioStart,
  quantizeAudioWarp,
  quantizeChannel,
  quantizeMidi,
  warpSpans,
  type QuantizeSettings,
} from '../model/quantize'

function note(partial: Partial<MidiNote> & Pick<MidiNote, 'id' | 'startBeat'>): MidiNote {
  return { pitch: 60, durationBeats: 0.25, velocity: 0.8, ...partial }
}

function settings(patch: Partial<QuantizeSettings>): QuantizeSettings {
  return { ...defaultQuantize(), ...patch }
}

describe('quantize engine', () => {
  it('moves by strength and again on the next pass', () => {
    const once = quantizeMidi([note({ id: 'a', startBeat: 0.2 })], settings({ division: 4, strength: 0.5 }))
    expect(once[0].startBeat).toBeCloseTo(0.1)
    const twice = quantizeMidi(once, settings({ division: 4, strength: 0.5 }))
    expect(twice[0].startBeat).toBeCloseTo(0.05)
  })

  it('leaves notes outside the window', () => {
    const wide = quantizeMidi([note({ id: 'a', startBeat: 0.2 })], settings({ division: 4, window: 50 }))
    expect(wide[0].startBeat).toBeCloseTo(0)
    const narrow = quantizeMidi([note({ id: 'a', startBeat: 0.4 })], settings({ division: 4, window: 50 }))
    expect(narrow[0].startBeat).toBeCloseTo(0.4)
    const quiet = quantizeMidi(
      [note({ id: 'a', startBeat: 0.2, velocity: 0.2 }), note({ id: 'b', startBeat: 0.2, velocity: 0.8 })],
      settings({ division: 4, threshold: 0.5 }),
    )
    expect(quiet[0].startBeat).toBeCloseTo(0.2)
    expect(quiet[1].startBeat).toBeCloseTo(0)
  })

  it('swings 16ths and 8ths', () => {
    const sixteenth = quantizeMidi([note({ id: 'a', startBeat: 0.25 }), note({ id: 'b', startBeat: 0 })], settings({ division: 16, swing: 0.5, swingUnit: '16' }))
    expect(sixteenth[0].startBeat).toBeCloseTo(0.375)
    expect(sixteenth[1].startBeat).toBeCloseTo(0)
    const eighth = quantizeMidi([note({ id: 'a', startBeat: 0.5 })], settings({ division: 8, swing: 0.5, swingUnit: '8' }))
    expect(eighth[0].startBeat).toBeCloseTo(0.75)
  })

  it('supports tuplets, dotted values, and a custom ratio', () => {
    expect(quantizeMidi([note({ id: 'a', startBeat: 0.3 })], settings({ division: 8, feel: 'triplet' }))[0].startBeat).toBeCloseTo(1 / 3)
    expect(quantizeMidi([note({ id: 'a', startBeat: 0.7 })], settings({ division: 8, feel: 'dotted' }))[0].startBeat).toBeCloseTo(0.75)
    expect(quantizeMidi([note({ id: 'a', startBeat: 0.7 })], settings({ division: 4, feel: 'quintuplet' }))[0].startBeat).toBeCloseTo(0.8)
    expect(quantizeMidi([note({ id: 'a', startBeat: 0.5 })], settings({ division: 4, feel: 'septuplet' }))[0].startBeat).toBeCloseTo(4 / 7)
    expect(quantizeMidi([note({ id: 'a', startBeat: 0.35 })], settings({ division: 4, feel: 'custom', tupletN: 5, tupletM: 2 }))[0].startBeat).toBeCloseTo(0.4)
  })

  it('extracts a groove and applies it', () => {
    const groove = extractGroove([0, 0.3, 0.5])
    expect(groove.offsets[1]).toBeCloseTo(0.05)
    expect(groove.offsets[0]).toBeCloseTo(0)
    const applied = quantizeMidi([note({ id: 'a', startBeat: 0.25 })], settings({ division: 16, groove, swing: 0 }))
    expect(applied[0].startBeat).toBeCloseTo(0.3)
    const mpc = quantizeMidi([note({ id: 'a', startBeat: 0.25 })], settings({ division: 16, groove: mpcGroove(75) }))
    expect(mpc[0].startBeat).toBeCloseTo(0.375)
  })

  it('quantizes ends, fixes overlaps, and extends legato', () => {
    const ends = quantizeMidi([note({ id: 'a', startBeat: 0, durationBeats: 1.4 })], settings({ division: 4, starts: false, ends: true, keepLength: false }))
    expect(ends[0].startBeat).toBeCloseTo(0)
    expect(ends[0].durationBeats).toBeCloseTo(1)
    const overlap = quantizeMidi(
      [note({ id: 'a', startBeat: 0, durationBeats: 2 }), note({ id: 'b', startBeat: 1, durationBeats: 1, pitch: 60 })],
      settings({ starts: false, fixOverlaps: true }),
    )
    expect(overlap[0].durationBeats).toBeCloseTo(1)
    const legato = quantizeMidi(
      [note({ id: 'a', startBeat: 0, durationBeats: 0.25 }), note({ id: 'b', startBeat: 1, durationBeats: 0.25 })],
      settings({ starts: false, legato: true }),
    )
    expect(legato[0].durationBeats).toBeCloseTo(1)
    expect(legato[1].durationBeats).toBeCloseTo(0.25)
  })

  it('snaps pitch, velocity, and seeded humanize', () => {
    const pitched = quantizeMidi([note({ id: 'a', startBeat: 0, pitch: 61 })], settings({ starts: false, scaleSnap: true }), { root: 0, scale: 'ionian' })
    expect(pitched[0].pitch).toBe(60)
    const fixed = quantizeMidi([note({ id: 'a', startBeat: 0, velocity: 0.22 })], settings({ starts: false, velocity: 'fixed' }))
    expect(fixed[0].velocity).toBeCloseTo(0.25)
    const packed = quantizeMidi(
      [note({ id: 'a', startBeat: 0, velocity: 0.2 }), note({ id: 'b', startBeat: 1, velocity: 1 })],
      settings({ starts: false, velocity: 'compress', velocityCompress: 1 }),
    )
    expect(packed[0].velocity).toBeCloseTo(0.6)
    expect(packed[1].velocity).toBeCloseTo(0.6)
    const human = settings({ starts: false, humanizeMs: 10, humanizeVel: 0, seed: 3 })
    const first = quantizeMidi([note({ id: 'a', startBeat: 1 })], human, { tempo: 120 })
    const second = quantizeMidi([note({ id: 'a', startBeat: 1 })], human, { tempo: 120 })
    expect(first[0].startBeat).toBeCloseTo(second[0].startBeat)
    expect(Math.abs(first[0].startBeat - 1)).toBeLessThanOrEqual(0.02)
  })

  it('quantizes step nudges and audio transients', () => {
    const pattern = starterPattern()
    const kick = pattern.channels[0]
    kick.cells = kick.cells.map(() => emptyCell())
    kick.cells[1] = { ...emptyCell(), on: true, velocity: 1 }
    const once = quantizeChannel(kick, settings({ division: 4, strength: 0.5 }))
    expect(once[1].on).toBe(true)
    expect(once[1].nudge).toBeCloseTo(-0.125)
    const audio = new Float32Array(48000)
    audio[14400] = 1
    const hits = detectTransients(audio, 48000, 0)
    expect(hits).toContain(14400)
    const clip = {
      id: 'c',
      name: 'Take',
      bufferId: 'b',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'local' as const,
    }
    const warped = quantizeAudioWarp(clip, audio, 48000, 120, settings({ division: 4 }))
    expect(warped.warpPoints?.some((point) => Math.abs(point.target - 1) < 1e-3)).toBe(true)
    const spans = warpSpans(warped, 48000, 120)
    expect(spans?.length).toBeGreaterThan(0)
    const shifted = quantizeAudioStart({ ...clip, startSample: 1000 }, audio, 48000, 120, settings({ division: 4 }))
    expect((shifted.startSample + 14400) / 24000).toBeCloseTo(1)
  })

  it('quantizes recorded notes live or after the take, and undoes an apply', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clipId = store.selectedMidiClipId!
    store.project.quantize = settings({ record: 'live', division: 4, strength: 1 })
    store.beginTake()
    store.addNote(track.id, clipId, { pitch: 60, startBeat: 0.2, durationBeats: 1, velocity: 0.8 })
    const live = () => store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes
    expect(live()[0].startBeat).toBeCloseTo(0)
    store.endTake()

    store.project.quantize = settings({ record: 'after', division: 4, strength: 1 })
    store.beginTake()
    store.addNote(track.id, clipId, { pitch: 62, startBeat: 0.2, durationBeats: 1, velocity: 0.8 })
    expect(live()[1].startBeat).toBeCloseTo(0.2)
    store.endTake()
    expect(live()[1].startBeat).toBeCloseTo(0)

    live()[1].startBeat = 0.2
    store.quickQuantize()
    expect(live()[1].startBeat).toBeCloseTo(0)
    store.undo()
    expect(live()[1].startBeat).toBeCloseTo(0.2)
  })
})
