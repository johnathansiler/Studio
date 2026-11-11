import { prepareChainPool, type ChainSlot } from './plugins/chain'
import { prepareAccurate } from './automationRender'
import { loadProcessors } from './plugins/loadProcessors'
import { renderInserts } from './renderChain'
import { bellIndex, claimTrack, finishTrack, sabInts } from './core/sabClock'
import type { Processor } from './plugins/types'

interface PrepareMsg {
  type: 'prepare'
  slot: number
  sampleRate: number
  wasm?: boolean
  plugins: { id: string; pluginId: string; enabled: boolean; wet: number; params: Record<string, number>; sidechain: string }[]
}

interface Port {
  onMessage(handler: (data: PrepareMsg | { type: string }) => void): void
  postMessage(data: unknown): void
}

/**
 * One worker serves the slots it is given. Plugin state stays here so the
 * audio thread only copies the quantum.
 */
export function serveRealtime(port: Port, sab: SharedArrayBuffer, mine: number[]) {
  const owned = new Set(mine)
  const chains = new Map<number, { slots: ChainSlot[]; sampleRate: number; pool: ReturnType<typeof prepareChainPool>; scratch: ReturnType<typeof prepareAccurate> }>()
  const ints = sabInts(sab)
  let seen = 0
  let stopped = false
  port.onMessage((data) => {
    if (data?.type === 'stop') {
      stopped = true
      Atomics.notify(ints, bellIndex(), 1)
      return
    }
    if (data?.type !== 'prepare') return
    const msg = data as PrepareMsg
    if (!owned.has(msg.slot)) return
    void prepare(msg).then((slots) => {
      const width = Math.max(1, slots.length)
      chains.set(msg.slot, { slots, sampleRate: msg.sampleRate, pool: prepareChainPool(width, 2, 128), scratch: prepareAccurate(width, 128) })
      port.postMessage({ type: 'ready', slot: msg.slot })
    }).catch((error: Error) => {
      port.postMessage({ type: 'error', slot: msg.slot, message: error?.message || 'prepare failed' })
    })
  })
  const loop = () => {
    if (stopped) return
    let bell = Atomics.load(ints, bellIndex())
    if (bell !== seen) {
      seen = bell
      pump()
    }
    if (stopped) return
    Atomics.wait(ints, bellIndex(), seen, 50)
    if (stopped) return
    bell = Atomics.load(ints, bellIndex())
    if (bell !== seen) {
      seen = bell
      pump()
    }
    setTimeout(loop, 0)
  }
  setTimeout(loop, 0)
  function pump() {
    for (const slot of owned) {
      const chain = chains.get(slot)
      const job = claimTrack(sab, slot)
      if (!chain || !job) continue
      const output = renderInserts(chain.slots, job.input, {
        sampleRate: chain.sampleRate,
        tempo: 120,
        automation: [],
        scaleRoot: 0,
        scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
        offline: false,
      }, () => null, chain.pool, chain.scratch)
      job.output[0].set(output[0].subarray(0, job.frames))
      job.output[1].set(output[1].subarray(0, job.frames))
      finishTrack(sab, slot)
    }
  }
}

async function prepare(msg: PrepareMsg) {
  if (msg.wasm === false) (globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__ = false
  if (msg.wasm === true) (globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__ = true
  const { createProcessor, preloadWasmInserts } = await loadProcessors()
  await preloadWasmInserts()
  return msg.plugins.map((plugin): ChainSlot => ({
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: { ...plugin.params },
    failed: false,
    sidechain: plugin.sidechain || '',
    processor: createProcessor(plugin.pluginId, msg.sampleRate) ?? passthrough(),
  }))
}

function passthrough(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        if (src) output[c].set(src)
      }
    },
  }
}
