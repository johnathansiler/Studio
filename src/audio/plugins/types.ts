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
  /** Cents above the tonic. Present when the block follows the project scale, including quarter tones. */
  scaleCents?: readonly number[]
  quality: 'full' | 'eco'
  /** Offline bounces use linear-phase EQ and 4x oversampling. Live preview stays lighter. */
  offline?: boolean
}

export interface Processor {
  latencySamples: number
  spectrum?: Float32Array
  /** Chromatic tuner readout. `cents` is signed distance to the nearest semitone. */
  tuner?: { hz: number; cents: number; note: number }
  /** Needle ballistics. vu is dB relative to 0 VU. gr is positive reduction. */
  meter?: { vu: number; gr: number }
  /** Tune graph pairs: detected Hz, then the corrected target Hz. */
  trace?: Float32Array
  /** Latest loudness and stereo readings, when this processor measures them. */
  meters?: Record<string, number>
  /** Interleaved left/right pairs for the goniometer. */
  scope?: Float32Array
  reset(): void
  process(input: Float32Array[], output: Float32Array[], params: Record<string, number>, ctx: BlockContext): void
}

export interface PluginModule {
  descriptor: PluginDescriptor
  presets: FactoryPreset[]
  create(sampleRate: number): Processor
}
