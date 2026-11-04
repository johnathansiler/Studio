import { mkdirSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { describe, expect, it } from 'vitest'
import { compensateGraph } from '../audio/core/latency'
import {
  countOverruns,
  createScheduler,
  feedbackMessage,
  mixGraphFromRoutes,
  scheduleRoutes,
} from '../audio/core/graph'
import { benchmarkMixGraph, REALTIME_LIMIT } from '../audio/graphBench'
import { MASTER } from '../audio/routing'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('mix graph', () => {
  it('orders tracks before the bus they feed, and the bus before master', () => {
    const schedule = scheduleRoutes([
      { id: 'vocal', dest: 'bus', sends: ['reverb'], latency: 0, kind: 'track' },
      { id: 'drum', dest: MASTER, sends: [], latency: 0, kind: 'track' },
      { id: 'bus', dest: MASTER, sends: [], latency: 0, kind: 'bus' },
      { id: 'reverb', dest: MASTER, sends: [], latency: 0, kind: 'bus' },
      { id: MASTER, dest: null, sends: [], latency: 0, kind: 'master' },
    ])
    expect(schedule.feedback).toBeNull()
    const at = (id: string) => schedule.order.indexOf(id)
    expect(at('vocal')).toBeGreaterThanOrEqual(0)
    expect(at('vocal')).toBeLessThan(at('bus'))
    expect(at('vocal')).toBeLessThan(at('reverb'))
    expect(at('drum')).toBeLessThan(at('master'))
    expect(at('bus')).toBeLessThan(at('master'))
    expect(at('reverb')).toBeLessThan(at('master'))
    expect(schedule.waves[0]).toEqual(['vocal', 'drum'])
    expect(schedule.waves[1]).toEqual(['bus', 'reverb'])
    expect(schedule.waves[2]).toEqual(['master'])
    const graph = mixGraphFromRoutes(schedule.graph.nodes.map((node) => ({
      id: node.id,
      dest: schedule.graph.edges.find((edge) => edge.from === node.id && edge.kind === 'output')?.to ?? null,
      sends: schedule.graph.edges.filter((edge) => edge.from === node.id && edge.kind === 'send').map((edge) => edge.to),
      latency: node.latency,
      kind: node.kind,
    })))
    expect(graph.edges).toContainEqual({ from: 'vocal', to: 'bus', kind: 'output' })
    expect(graph.edges).toContainEqual({ from: 'vocal', to: 'reverb', kind: 'send' })
    expect(graph.nodes.find((node) => node.id === 'bus')?.kind).toBe('bus')
    for (const edge of schedule.graph.edges) {
      const from = schedule.waves.findIndex((wave) => wave.includes(edge.from))
      const to = schedule.waves.findIndex((wave) => wave.includes(edge.to))
      expect(from).toBeLessThan(to)
    }
  })

  it('refuses a feedback route with the loop in the message', () => {
    const loop = scheduleRoutes([
      { id: 'a', dest: 'b', sends: [], latency: 0 },
      { id: 'b', dest: 'a', sends: [], latency: 0 },
    ])
    expect(loop.feedback?.path).toEqual(['a', 'b'])
    expect(loop.feedback?.message).toBe(feedbackMessage(['a', 'b']))
    expect(loop.feedback?.message).toContain('Feedback route refused: a → b → a')
    expect(loop.order).toEqual([])
    expect(loop.waves).toEqual([])
    const send = scheduleRoutes([
      { id: 'vocal', dest: MASTER, sends: ['bus'], latency: 0 },
      { id: 'bus', dest: 'vocal', sends: [], latency: 0 },
    ])
    expect(send.feedback?.path).not.toBeNull()
    expect(send.feedback?.message).toContain('Feedback route refused')
    const self = scheduleRoutes([{ id: 'bus', dest: 'bus', sends: [], latency: 0 }])
    expect(self.feedback?.path).toEqual(['bus'])
    expect(self.feedback?.message).toContain('bus → bus')
    const open = scheduleRoutes([
      { id: 'a', dest: 'bus', sends: ['verb'], latency: 0 },
      { id: 'bus', dest: MASTER, sends: [], latency: 0 },
      { id: 'verb', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect(open.feedback).toBeNull()
  })

  it('propagates latency through sends and buses into the compensation pass', () => {
    const points = [
      { id: 'vocal', dest: MASTER, sends: ['reverb'], latency: 5 },
      { id: 'drum', dest: MASTER, sends: [], latency: 0 },
      { id: 'reverb', dest: MASTER, sends: [], latency: 100 },
      { id: MASTER, dest: null, sends: [], latency: 8 },
    ]
    const schedule = scheduleRoutes(points)
    expect(schedule.outputLatency.get('vocal')).toBe(5)
    expect(schedule.outputLatency.get('drum')).toBe(0)
    expect(schedule.outputLatency.get('reverb')).toBe(105)
    expect(schedule.outputLatency.get('master')).toBe(113)
    expect(schedule.delays.get('vocal>master')).toBe(100)
    expect(schedule.delays.get('drum>master')).toBe(105)
    expect(schedule.delays.get('vocal>reverb')).toBe(0)
    expect(schedule.delays.get('reverb>master')).toBe(0)
    const compensated = compensateGraph(points)
    expect(compensated.get('drum>master')).toBe(schedule.delays.get('drum>master'))
    expect(compensated.get('vocal>master')).toBe(100)
    const nested = scheduleRoutes([
      { id: 'child', dest: 'bus', sends: [], latency: 10 },
      { id: 'bus', dest: MASTER, sends: [], latency: 20 },
      { id: 'dry', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect(nested.outputLatency.get('child')).toBe(10)
    expect(nested.outputLatency.get('bus')).toBe(30)
    expect(nested.delays.get('child>bus')).toBe(0)
    expect(nested.delays.get('dry>master')).toBe(30)
    expect(nested.delays.get('bus>master')).toBe(0)
  })

  it('lets a worker take another track while a bus is still waiting', () => {
    const scheduler = createScheduler([
      { id: 'slow', dest: 'bus', sends: [], latency: 0 },
      { id: 'fast', dest: MASTER, sends: [], latency: 0 },
      { id: 'free', dest: MASTER, sends: [], latency: 0 },
      { id: 'bus', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect([scheduler.take(), scheduler.take(), scheduler.take()]).toEqual(['slow', 'fast', 'free'])
    expect(scheduler.take()).toBeNull()
    scheduler.complete('fast')
    scheduler.complete('free')
    expect(scheduler.take()).toBeNull()
    scheduler.complete('slow')
    expect(scheduler.take()).toBe('bus')
    expect(scheduler.done()).toBe(false)
    scheduler.complete('bus')
    expect(scheduler.take()).toBe('master')
    scheduler.complete('master')
    expect(scheduler.done()).toBe(true)
    expect(scheduler.take()).toBeNull()
  })

  it('tells the store which loop it refused', () => {
    const store = new ProjectStore(createEmptyProject())
    store.addTrack('bus')
    const bus = store.project.tracks.find((track) => track.type === 'bus')!
    store.addTrack('bus')
    const other = store.project.tracks.filter((track) => track.type === 'bus')[1]
    store.updateTrack(bus.id, { output: other.id })
    store.updateTrack(other.id, { output: bus.id })
    expect(store.project.tracks.find((track) => track.id === other.id)?.output).toBeNull()
    expect(store.toasts.some((toast) => toast.text.includes('Feedback route refused') && toast.text.includes(bus.name) && toast.text.includes(other.name))).toBe(true)
  })

  it('counts a dropout when a quantum overruns the buffer', () => {
    const score = countOverruns([1, 3, 2.7], 128, 48000)
    expect(score.budgetMs).toBeCloseTo((128 / 48000) * 1000, 6)
    expect(score.blocks).toBe(3)
    expect(score.dropouts).toBe(2)
    expect(score.worstMs).toBe(3)
    expect(countOverruns([0.2, 0.4], 128, 48000).dropouts).toBe(0)
  })

  it('renders independent tracks on workers and keeps the mix', async () => {
    const report = await benchmarkMixGraph({ tracks: 8, seconds: 0.75, blocks: 4 })
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/graph-benchmark.json', JSON.stringify(report, null, 2))
    expect(report.realtime.adopted).toBe('single-audio-thread')
    expect(report.realtime.reason).toBe(REALTIME_LIMIT)
    expect(report.realtime.after).toEqual(report.realtime.before)
    expect(report.realtime.workerRoundTrip.meanMs).toBeGreaterThan(report.realtime.before.meanMs)
    expect(report.offline.maxError).toBeLessThan(1e-5)
    expect(report.offline.sequentialMs).toBeGreaterThan(0)
    expect(report.offline.parallelMs).toBeGreaterThan(0)
    if (availableParallelism() >= 2) expect(report.offline.speedup).toBeGreaterThan(1.15)
  }, 120_000)
})
