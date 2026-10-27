import { describe, expect, it } from 'vitest'
import {
  applyOrb,
  arpNotes,
  blendPatches,
  compileScript,
  memoryBudget,
  mutatePatch,
  pickZones,
  planStream,
  renderLayer,
  renderNote,
  resolveLayer,
  runScript,
  slotFor,
  starterInstrument,
  starterLoom,
  starterPatch,
  type Layer,
} from '../model/loom'

const instrument = starterInstrument()

function pick(partial: Partial<Parameters<typeof pickZones>[1]>) {
  return pickZones(instrument, {
    note: 60,
    vel: 0.4,
    articulation: 'sustain',
    cc1: 0,
    rr: 0,
    trigger: 'attack',
    lite: false,
    seed: 3,
    interval: null,
    ...partial,
  })
}

describe('loom engine', () => {
  it('picks velocity layers, cycles round robins, and fires release samples', () => {
    const quiet = pick({ vel: 0.3 }).hits.filter((hit) => hit.zone.mic === 'close')
    const loud = pick({ vel: 1 }).hits.filter((hit) => hit.zone.mic === 'close')
    expect(quiet.every((hit) => hit.zone.hivel <= 80)).toBe(true)
    expect(loud.every((hit) => hit.zone.lovel >= 81)).toBe(true)
    expect(pick({ rr: 0 }).hits.find((hit) => hit.zone.mic === 'close')?.zone.rr).toBe(0)
    expect(pick({ rr: 1 }).hits.find((hit) => hit.zone.mic === 'close')?.zone.rr).toBe(1)
    expect(pick({ rr: 2 }).hits.find((hit) => hit.zone.mic === 'close')?.zone.rr).toBe(0)
    const release = pick({ trigger: 'release' })
    expect(release.hits.map((hit) => hit.zone.sampleId)).toEqual(['sustain-rel'])
  })

  it('switches articulations from keyswitches and crossfades dynamics', () => {
    const switched = pick({ note: 26 })
    expect(switched.keyswitch).toBe('pizz')
    expect(switched.hits).toHaveLength(0)
    expect(renderNote(starterLoom(), 26, 0.8, 48000, 32).every((sample) => sample === 0)).toBe(true)
    const mid = pick({ cc1: 0.5 }).hits.filter((hit) => hit.zone.mic === 'close' && hit.zone.rr === 0)
    expect(mid.map((hit) => hit.zone.dynamic).sort()).toEqual([0, 1])
    expect(mid.every((hit) => Math.abs(hit.gain - 0.5) < 0.001)).toBe(true)
    const legato = pick({ trigger: 'legato', interval: 2 })
    expect(legato.hits.map((hit) => hit.zone.sampleId)).toContain('legato-2')
  })

  it('keeps phone streaming inside the memory budget and drops extra mics in lite', () => {
    const sizes = new Map(instrument.zones.map((zone) => [zone.sampleId, 200_000]))
    const phone = planStream(instrument.zones, 'sustain', true, memoryBudget('phone'), (id) => sizes.get(id) ?? 0)
    expect(phone.bytes).toBeLessThanOrEqual(memoryBudget('phone'))
    expect(phone.keep.length).toBeGreaterThan(0)
    expect(phone.keep.every((id) => !id.includes('room') && !id.includes('far') && !id.includes('-r1-'))).toBe(true)
    const desk = planStream(instrument.zones, 'sustain', false, memoryBudget('desk'), (id) => sizes.get(id) ?? 0)
    expect(desk.bytes).toBeLessThanOrEqual(memoryBudget('desk'))
    expect(desk.keep.length).toBeGreaterThan(phone.keep.length)
    const liteHits = pick({ lite: true, cc1: 0.5 }).hits
    expect(liteHits.every((hit) => hit.zone.mic === 'close' && hit.zone.rr === 0)).toBe(true)
    expect(liteHits).toHaveLength(1)
  })

  it('rejects scripts that try to leave the sandbox', () => {
    expect(compileScript('constructor.constructor("return process")()').error).toBe('blocked')
    expect(compileScript('fetch(1)').error).toBe('blocked')
    expect(compileScript('humanize(globalThis)').error).toBe('blocked')
    const compiled = compileScript('humanize(6)\nstrum(18)\nlegato()\nif (vel > 0.5) cc(1, 0.2)')
    expect(compiled.error).toBeNull()
    const api = { detune: 0, strum: 0, legato: false, cc: [] as { controller: number; value: number }[] }
    runScript(compiled.script!, api, { vel: 0.8, note: 60 })
    expect(api).toMatchObject({ detune: 6, strum: 18, legato: true })
    expect(api.cc).toEqual([{ controller: 1, value: 0.2 }])
  })

  it('routes the mod matrix, blends patches, and stays deterministic', () => {
    const base: Layer = { kind: 'analog', level: 0.2, pan: 0, cutoff: 0.2, attack: 0, decay: 0, sustain: 1, release: 0, lfoRate: 0, lfoDepth: 0, grain: 0.1 }
    const resolved = resolveLayer(base, [{ source: 'lfo', dest: 'cutoff', amount: 0.5 }, { source: 'vel', dest: 'level', amount: 0.4 }], { lfo: 1, env: 0, vel: 1, cc1: 0, note: 0.5 })
    expect(resolved.cutoff).toBeCloseTo(0.7)
    expect(resolved.level).toBeCloseTo(0.6)
    const patch = starterPatch()
    const other = { ...patch, id: 'b', name: 'B', macros: [1, 0, 1, 0] as [number, number, number, number] }
    const blended = blendPatches(patch, other, 0.5)
    expect(blended.macros[0]).toBeCloseTo((patch.macros[0] + 1) / 2)
    const spun = mutatePatch(patch, 9)
    expect(mutatePatch(patch, 9)).toEqual(spun)
    expect(spun.layers.length).toBeLessThanOrEqual(4)
    const orb = applyOrb(patch, 1, 0)
    expect(orb.macros[0]).toBe(1)
    expect(orb.layers[0].cutoff).toBeGreaterThan(0)
    expect(arpNotes([64, 60, 67], 5, 'up')).toEqual([60, 64, 67, 60, 64])
    const routed = slotFor(
      [
        { instrumentId: 'a', channel: 1, low: 0, high: 59, output: 0 },
        { instrumentId: 'b', channel: 1, low: 60, high: 127, output: 1 },
      ],
      1,
      72,
    )
    expect(routed?.instrumentId).toBe('b')
    const tone = renderLayer('fm', 128, 48000, 220, 1)
    expect(tone.some((sample) => Math.abs(sample) > 0.01)).toBe(true)
    const voice = renderNote(starterLoom(), 60, 0.8, 48000, 64)
    expect(voice.length).toBe(64)
    expect(voice.every((sample) => Number.isFinite(sample))).toBe(true)
  })
})
