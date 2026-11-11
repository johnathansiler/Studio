import { describe, expect, it } from 'vitest'
import { CATALOG, createPlugin, defaultParams, normalizeProject } from '../audio/plugins/catalog'
import { createCore } from '../audio/plugins/dispatch'
import { CORE_IDS, MOVES, migratePlugin } from '../audio/plugins/ids'
import { createEmptyProject, type PluginInstance } from '../model/types'
import type { Processor } from '../audio/plugins/types'

function insert(pluginId: string, params: Record<string, number> = {}, extra: Partial<PluginInstance> = {}): PluginInstance {
  return {
    id: `old-${pluginId}`,
    pluginId,
    version: '1',
    enabled: true,
    wet: 0.8,
    params,
    sidechain: '',
    ...extra,
  }
}

function finite(buffer: Float32Array) {
  for (let i = 0; i < buffer.length; i++) if (!Number.isFinite(buffer[i])) return false
  return true
}

describe('plugin id migration', () => {
  it('publishes exactly the twelve core plugins', () => {
    expect(CATALOG.map((plugin) => plugin.id)).toEqual([...CORE_IDS])
    expect(CATALOG.map((plugin) => plugin.name)).toEqual([
      'Auto-Tune',
      'EQ',
      'Comp',
      'Vocal Clean',
      'Sat',
      'Reverb',
      'Delay',
      'Mod',
      'Scaler',
      'Synth',
      'Sampler',
      'Master Limiter',
    ])
  })

  it('loads every retired id as the core plugin it folded into', () => {
    const project = createEmptyProject()
    project.masterPlugins = []
    project.tracks[0].plugins = [
      insert('eq', { lowG: 3, midG: -2, highG: 1.5 }),
      insert('passive', { lowF: 1, lowBoost: 0.4, highBoost: 0.2 }),
      insert('pre', { hp: 2, lowG: -3, drive: 0.2 }),
      insert('channel', { lfG: 2, hfG: 1 }),
      insert('prop', { freq: 7, gain: 3 }),
      insert('focus', { f1: 3200, g1: 2, ms: 2, linear: 1 }),
      insert('meq', { phase: 1, ms: 1, sLow: 4, lowG: 1.25, midG: -1 }),
      insert('deq', { freq: 3500, q: 1.4, threshold: -20, gain: -3 }),
      insert('compressor', { threshold: -18, ratio: 3, attack: 8 }),
      insert('fet', { input: 8, output: -2, ratio: 3, attack: 0.1, release: 200 }),
      insert('opto', { peak: 0.45, gain: 8 }),
      insert('bus', { threshold: -16, ratio: 1, attack: 2, hpf: 90 }),
      insert('vari', { time: 2, input: 4, color: 0.3 }),
      insert('glue', { threshold: -8, ratio: 4, releaseMode: 1 }),
      insert('mbcomp', { bands: 4, threshold: -16, ms: 1, x2: 480 }),
      insert('gate', { threshold: -42, ratio: 8, attack: 3, hold: 25 }),
      insert('deesser', { freq: 6800, threshold: -22, amount: 0.55 }),
      insert('saturator', { drive: 0.4, tone: 6000, mix: 0.7 }),
      insert('tape', { speed: 2, drive: 0.45, wow: 0.1 }),
      insert('sum', { drive: 0.3, tube: 1 }),
      insert('mtape', { drive: 0.3, color: 1, mix: 0.6 }),
      insert('clip', { drive: 0.4, mode: 1, ceiling: -0.3 }),
      insert('amp', { model: 3, gain: 0.62, bass: 0.4 }),
      insert('reverb', { mode: 2, size: 0.7, mix: 0.2 }),
      insert('plate', { size: 0.4, decay: 0.6, damp: 0.3, mix: 0.2 }),
      insert('hall', { mode: 1, size: 0.8, decay: 0.9, mix: 0.24 }),
      insert('conv', { ir: 1, mix: 0.3 }),
      insert('delay', { time: 375, feedback: 0.3, mix: 0.25 }),
      insert('echo', { time: 320, feedback: 0.28, wow: 0.3, drive: 0.35, mix: 0.22 }),
      insert('bbd', { time: 180, feedback: 0.3, clock: 0.6, mix: 0.2 }),
      insert('digital', { time: 250, feedback: 0.25, mix: 0.18 }),
      insert('chorus', { rate: 0.3, depth: 0.4, mix: 0.3 }),
      insert('doubler', { width: 0.8, delay: 22, depth: 0.4, mix: 0.45 }),
      insert('ensemble', { rate: 0.2, depth: 0.5, mode: 1, mix: 0.4 }),
      insert('phase', { rate: 0.2, depth: 0.6, feedback: 0.4, mix: 0.5 }),
      insert('rotor', { speed: 1, mix: 0.7 }),
      insert('pitch', { semis: 12, harmony: 7, harmonyMix: 0.4, mix: 0.8 }),
      insert('peak', { ceiling: -1.5, release: 40 }),
      insert('brick', { ceiling: -1, release: 80, lookahead: 6 }),
      insert('maxim', { target: -14, ceiling: -1 }),
      insert('image', { width: 1.4, bass: 140, low: 0.8, high: 1.3 }),
      insert('dither', { bits: 16, shape: 2 }),
      insert('msbox', { mid: 1.5, side: 4 }),
      insert('meter'),
      insert('looper', {}, {
        looper: {
          layers: [{ id: 'layer', bufferId: 'loop-buf', gain: 1, mute: false, reverse: false, speed: 1 }],
          undone: [],
          sync: true,
          bars: 1,
          feedback: 0.8,
          transport: 0,
          startBeat: 0,
          lengthSamples: 48000,
          sourceRate: 44100,
        },
      }),
      insert('pads'),
      insert('scaler'),
    ]
    normalizeProject(project)
    const plugins = project.tracks[0].plugins
    const byId = (id: string) => plugins.find((plugin) => plugin.id === `old-${id}`)!

    expect(plugins.some((plugin) => plugin.pluginId === 'meter' || plugin.pluginId === 'looper' || plugin.pluginId === 'msbox' || plugin.pluginId === 'peak')).toBe(false)
    expect(plugins.some((plugin) => plugin.id === 'old-meter')).toBe(false)

    expect(byId('eq')).toMatchObject({ pluginId: 'eq', params: { kind: 0, lowG: 3, midG: -2, highG: 1.5 } })
    expect(byId('passive')).toMatchObject({ pluginId: 'eq', params: { kind: 1, pLow: 1, pBoost: 0.4, pAir: 0.2 } })
    expect(byId('pre')).toMatchObject({ pluginId: 'eq', params: { kind: 2, preHp: 2, preLowG: -3, preDrive: 0.2 } })
    expect(byId('channel')).toMatchObject({ pluginId: 'eq', params: { kind: 3, lfG: 2, hfG: 1 } })
    expect(byId('prop')).toMatchObject({ pluginId: 'eq', params: { kind: 4, tiltF: 7, tiltG: 3 } })
    expect(byId('focus').params.kind).toBe(5)
    expect(byId('focus').params.ms).toBeUndefined()
    expect(byId('focus').params.linear).toBe(1)
    expect(byId('focus').params.f1).toBe(3200)
    expect(byId('meq').params).toMatchObject({ kind: 6, chain: 1, lowG: 1.25, midG: -1 })
    expect(byId('meq').params.ms).toBeUndefined()
    expect(byId('meq').params.sLow).toBeUndefined()
    expect(byId('deq')).toMatchObject({ pluginId: 'eq', params: { kind: 7, dynF: 3500, dynQ: 1.4, dynThresh: -20, dynG: -3 } })

    expect(byId('compressor')).toMatchObject({ pluginId: 'compressor', params: { kind: 0, threshold: -18, ratio: 3, attack: 8 } })
    expect(byId('fet')).toMatchObject({ pluginId: 'compressor', params: { kind: 1, fetIn: 8, fetOut: -2, fetRatio: 3, fetAtk: 0.1, fetRel: 200 } })
    expect(byId('opto')).toMatchObject({ pluginId: 'compressor', params: { kind: 2, optoPeak: 0.45, optoGain: 8 } })
    expect(byId('bus')).toMatchObject({ pluginId: 'compressor', params: { kind: 3, busThresh: -16, busRatio: 1, hpf: 90 } })
    expect(byId('vari')).toMatchObject({ pluginId: 'compressor', params: { kind: 4, variTime: 2, variIn: 4, variColor: 0.3 } })
    expect(byId('glue')).toMatchObject({ pluginId: 'compressor', params: { kind: 5, threshold: -8, ratio: 4, releaseMode: 1, chain: 1 } })
    expect(byId('mbcomp').params.kind).toBe(6)
    expect(byId('mbcomp').params.ms).toBeUndefined()
    expect(byId('mbcomp').params.x2).toBe(480)

    expect(byId('gate')).toMatchObject({ pluginId: 'vocal', params: { kind: 2, gate: -42, gateRatio: 8, gateAtk: 3, hold: 25 } })
    expect(byId('deesser')).toMatchObject({ pluginId: 'vocal', params: { kind: 1, freq: 6800, threshold: -22, amount: 0.55 } })

    expect(byId('saturator')).toMatchObject({ pluginId: 'saturator', params: { kind: 0, drive: 0.4, tone: 6000, mix: 0.7 } })
    expect(byId('tape')).toMatchObject({ pluginId: 'saturator', params: { kind: 1, speed: 2, drive: 0.45, wow: 0.1 } })
    expect(byId('sum')).toMatchObject({ pluginId: 'saturator', params: { kind: 2, drive: 0.3, tube: 1 } })
    expect(byId('mtape')).toMatchObject({ pluginId: 'saturator', params: { kind: 3, color: 1, mix: 0.6, chain: 1 } })
    expect(byId('clip')).toMatchObject({ pluginId: 'saturator', params: { kind: 4, drive: 0.4, clipMode: 1, ceiling: -0.3 } })
    expect(byId('amp')).toMatchObject({ pluginId: 'saturator', params: { kind: 5, model: 3, gain: 0.62, bass: 0.4 } })

    expect(byId('reverb')).toMatchObject({ pluginId: 'reverb', params: { kind: 0, mode: 2, size: 0.7, mix: 0.2 } })
    expect(byId('plate')).toMatchObject({ pluginId: 'reverb', params: { kind: 1, size: 0.4, decay: 0.6, mix: 0.2 } })
    expect(byId('hall')).toMatchObject({ pluginId: 'reverb', params: { kind: 2, mode: 1, size: 0.8, decay: 0.9 } })
    expect(byId('conv')).toMatchObject({ pluginId: 'reverb', params: { kind: 3, ir: 1, mix: 0.3 } })

    expect(byId('delay')).toMatchObject({ pluginId: 'delay', params: { kind: 0, time: 375, mix: 0.25 } })
    expect(byId('echo')).toMatchObject({ pluginId: 'delay', params: { kind: 1, wow: 0.3, drive: 0.35 } })
    expect(byId('bbd')).toMatchObject({ pluginId: 'delay', params: { kind: 2, clock: 0.6, time: 180 } })
    expect(byId('digital')).toMatchObject({ pluginId: 'delay', params: { kind: 3, time: 250 } })

    expect(byId('chorus')).toMatchObject({ pluginId: 'mod', params: { kind: 0, rate: 0.3, mix: 0.3 } })
    expect(byId('doubler')).toMatchObject({ pluginId: 'mod', params: { kind: 1, width: 0.8, delay: 22 } })
    expect(byId('ensemble')).toMatchObject({ pluginId: 'mod', params: { kind: 2, mode: 1, mix: 0.4 } })
    expect(byId('phase')).toMatchObject({ pluginId: 'mod', params: { kind: 3, feedback: 0.4 } })
    expect(byId('rotor')).toMatchObject({ pluginId: 'mod', params: { kind: 4, speed: 1 } })
    expect(byId('pitch')).toMatchObject({ pluginId: 'mod', params: { kind: 5, semis: 12, harmonyMix: 0.4 } })

    expect(byId('peak')).toMatchObject({ pluginId: 'limiter', params: { kind: 1, ceiling: -1.5, release: 40 } })
    expect(byId('brick')).toMatchObject({ pluginId: 'limiter', params: { kind: 1, ceiling: -1, lookahead: 6, chain: 1 } })
    expect(byId('maxim')).toMatchObject({ pluginId: 'limiter', params: { kind: 2, target: -14, ceiling: -1, chain: 1 } })
    expect(byId('image')).toMatchObject({ pluginId: 'limiter', params: { kind: 0, width: 1.4, bass: 140, chain: 1 } })
    expect(byId('dither')).toMatchObject({ pluginId: 'limiter', params: { kind: 0, bits: 16, shape: 2, chain: 1 } })
    expect(byId('msbox')).toMatchObject({ pluginId: 'eq', params: { kind: 0, midG: 1.5, chain: 1 } })
    expect(byId('msbox').params.side).toBeUndefined()

    expect(byId('looper')).toMatchObject({ pluginId: 'sampler', looper: undefined })
    expect(byId('looper').sampler?.bufferId).toBe('loop-buf')
    expect(byId('looper').sampler?.sourceRate).toBe(44100)
    expect(byId('pads')).toMatchObject({ pluginId: 'sampler', params: { kind: 1 } })
    expect(byId('scaler').pluginId).toBe('scaler')

    const again = migratePlugin(byId('fet'), defaultParams)
    expect(again?.pluginId).toBe('compressor')
    expect(again?.params.fetIn).toBe(8)
    expect(again?.params.kind).toBe(1)

    for (const id of Object.keys(MOVES)) {
      const move = MOVES[id]
      if (move.remove) continue
      expect(CORE_IDS).toContain(move.to)
    }
  })

  it('loads every legacy id as the current plugin and kind, with the same parameter values', () => {
    for (const [id, move] of Object.entries(MOVES)) {
      const project = createEmptyProject()
      project.masterPlugins = []
      const params: Record<string, number> = { marker: 0.42 }
      const renamed = move.rename ? Object.entries(move.rename).find(([from]) => !move.drop?.includes(from)) : undefined
      if (renamed) params[renamed[0]] = 1.25
      project.tracks[0].plugins = [insert(id, params)]
      normalizeProject(project)
      const found = project.tracks[0].plugins.find((plugin) => plugin.id === `old-${id}`)
      if (move.remove) {
        expect(found, id).toBeUndefined()
        continue
      }
      expect(found?.pluginId, id).toBe(move.to)
      expect(found?.params.kind, id).toBe(move.kind)
      expect(found?.wet, id).toBe(0.8)
      expect(found?.params.marker, id).toBe(0.42)
      if (renamed) expect(found?.params[renamed[1]], `${id} ${renamed[0]}`).toBe(1.25)
      if (move.drop) for (const key of move.drop) expect(found?.params[key], `${id} drop ${key}`).toBeUndefined()
      if (move.chain) expect(found?.params.chain, id).toBe(1)
      const made = createPlugin(id)
      expect(made.pluginId, `create ${id}`).toBe(move.to)
      expect(made.params.kind, `create ${id}`).toBe(move.kind)
    }
  })

  it('keeps each core kind finite on a tone', () => {
    const n = 2048
    const tone = new Float32Array(n)
    for (let i = 0; i < n; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.4
    const ctx = {
      sampleRate: 48000,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full' as const,
    }
    const cases: [string, number, Record<string, number>][] = [
      ['eq', 0, { lowG: 3 }],
      ['eq', 1, { pBoost: 0.4 }],
      ['eq', 6, { highG: 2, phase: 1 }],
      ['eq', 7, { dynG: -3, dynThresh: -30 }],
      ['compressor', 0, { threshold: -20, ratio: 4 }],
      ['compressor', 1, { fetIn: 6, fetRatio: 2 }],
      ['compressor', 5, { threshold: -12, ratio: 3, mix: 1 }],
      ['vocal', 0, { amount: 0.4, gate: -30, gateRatio: 4 }],
      ['saturator', 0, { drive: 0.5, mix: 1 }],
      ['saturator', 1, { drive: 0.4 }],
      ['saturator', 4, { drive: 0.3, clipMode: 0 }],
      ['reverb', 0, { mix: 0.3, mode: 1, size: 0.4 }],
      ['reverb', 1, { mix: 0.25, size: 0.4, decay: 0.5 }],
      ['delay', 0, { mix: 0.3, sync: 0, time: 80, feedback: 0.2 }],
      ['delay', 1, { mix: 0.3, time: 90, feedback: 0.2, wow: 0.2 }],
      ['mod', 0, { mix: 0.4, depth: 0.3 }],
      ['mod', 5, { mix: 0.2, semis: 0 }],
      ['limiter', 0, { threshold: -6, ceiling: -1 }],
      ['limiter', 1, { ceiling: -1, lookahead: 2, release: 40 }],
      ['sampler', 0, {}],
      ['tune', 0, { amount: 0 }],
    ]
    for (const [id, kind, patch] of cases) {
      const processor = createCore(id as Parameters<typeof createCore>[0], 48000)
      const params = { ...defaultParams(id), ...patch, kind }
      const left = new Float32Array(n)
      const right = new Float32Array(n)
      processor.process([tone, tone], [left, right], params, ctx)
      expect(finite(left), `${id}:${kind}`).toBe(true)
      expect(finite(right), `${id}:${kind}`).toBe(true)
    }
    const quiet: Processor = createCore('synth', 48000)
    const out = new Float32Array(32)
    quiet.process([tone.subarray(0, 32), tone.subarray(0, 32)], [out, new Float32Array(32)], {}, ctx)
    expect(out[0]).toBeCloseTo(tone[0])
  })
})
