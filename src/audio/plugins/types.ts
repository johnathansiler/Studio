/** Plugin contract. A Web Audio Module adapter can implement PluginModule later. */

export interface ParamSpec {
  id: string
  name: string
  min: number
  max: number
  default: number
  unit: string
  automatable: boolean
}

export interface PluginDescriptor {
  id: string
  name: string
  version: string
  params: ParamSpec[]
}

export interface FactoryPreset {
  name: string
  params: Record<string, number>
}

export interface BlockContext {
  sampleRate: number
  tempo: number
  sampleTime: number
  sidechain: Float32Array | null
  scaleRoot: number
  scaleIntervals: readonly number[]
  quality: 'full' | 'eco'
}

export interface Processor {
  latencySamples: number
  spectrum?: Float32Array
  /** Chromatic tuner readout. `cents` is signed distance to the nearest semitone. */
  tuner?: { hz: number; cents: number; note: number }
  reset(): void
  process(input: Float32Array[], output: Float32Array[], params: Record<string, number>, ctx: BlockContext): void
}

export interface PluginModule {
  descriptor: PluginDescriptor
  presets: FactoryPreset[]
  create(sampleRate: number): Processor
}
