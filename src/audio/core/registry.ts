import { descriptor } from '../plugins/catalog'
import { latencyOf } from '../plugins/catalog'
import { createProcessor } from '../plugins/createAll'
import { INSTRUMENT_IDS, kindLabels, targetOf } from '../plugins/ids'
import { adaptProcessor, adaptSequencer } from './adapt'
import type { NativePlugin, PluginLayout, PluginManifest } from './contract'
import type { ParamSpec } from '../plugins/types'

const STEPS: PluginLayout = {
  id: 'steps',
  name: 'Step Sequencer',
  version: '1',
  controls: [
    { paramId: 0, key: 'song', name: 'Song', min: 0, max: 1, defaultValue: 0, unit: '', automatable: false },
  ],
}

function layoutFrom(id: string, name: string, version: string, params: ParamSpec[]): PluginLayout {
  return {
    id,
    name,
    version,
    controls: params.map((spec, index) => ({
      paramId: index,
      key: spec.id,
      name: spec.name,
      min: spec.min,
      max: spec.max,
      defaultValue: spec.default,
      unit: spec.unit,
      automatable: spec.automatable,
    })),
  }
}

function categoryOf(id: string): PluginManifest['category'] {
  if (id === 'steps') return 'sequencer'
  if (INSTRUMENT_IDS.has(id)) return 'instrument'
  return 'insert'
}

/** Every built-in plugin as a JSON manifest. Native hosts replace `module` with a compiled bundle. */
export function pluginManifests(): PluginManifest[] {
  const ids = ['tune', 'eq', 'compressor', 'vocal', 'saturator', 'reverb', 'delay', 'mod', 'scaler', 'synth', 'sampler', 'limiter', 'steps']
  const manifests: PluginManifest[] = []
  for (const id of ids) {
    const manifest = manifestFor(id)
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

export function manifestFor(id: string): PluginManifest | null {
  if (id === 'steps') {
    return {
      id: 'steps',
      name: 'Step Sequencer',
      version: '1',
      category: 'sequencer',
      module: 'steps',
      layout: STEPS,
    }
  }
  const core = targetOf(id)
  const spec = descriptor(core)
  if (!spec) return null
  const modes = kindLabels(core)
  return {
    id: core,
    name: spec.name,
    version: spec.version,
    category: categoryOf(core),
    module: core,
    layout: layoutFrom(core, spec.name, spec.version, spec.params),
    modes: modes.length ? modes : undefined,
  }
}

/** Build the portable plugin around the processor the app already runs. */
export function createNativePlugin(id: string, sampleRate: number): NativePlugin | null {
  if (id === 'steps') {
    const plugin = adaptSequencer(STEPS)
    plugin.prepare(sampleRate, 128)
    return plugin
  }
  const core = targetOf(id)
  const spec = descriptor(core)
  if (!spec) return null
  const plugin = adaptProcessor({
    id: core,
    name: spec.name,
    version: spec.version,
    params: spec.params,
    create: (rate) => {
      const proc = createProcessor(core, rate)
      if (!proc) throw new Error(`Missing processor ${core}`)
      return proc
    },
    latency: (params, rate) => latencyOf(core, params, rate, true, true),
    note: (proc, pitch, velocity) => {
      const play = proc as ProcessorNote
      play.note?.(pitch, velocity)
    },
  })
  plugin.prepare(sampleRate, 128)
  return plugin
}

interface ProcessorNote {
  note?: (pitch: number, velocity: number) => void
}
