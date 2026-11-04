/**
 * Host-agnostic plugin contract.
 *
 * No DOM, Web Audio, or browser types. A later Rust or C++ core can keep
 * these fields: the web host, a native app (CoreAudio / Oboe), and a
 * VST3 / AU / AAX wrapper all pass the same blocks, MIDI, and parameter ids.
 */

export interface AudioBlock {
  /** Channel pointers. Index 0 is left. The host owns the memory. */
  channels: Float32Array[]
  numChannels: number
  numSamples: number
}

export interface MidiEvent {
  /** Sample index inside the current block. */
  sampleOffset: number
  status: number
  data1: number
  data2: number
}

export interface MidiBlock {
  events: readonly MidiEvent[]
  numEvents: number
}

export const EMPTY_MIDI: MidiBlock = { events: [], numEvents: 0 }

export interface ControlLayout {
  paramId: number
  key: string
  name: string
  min: number
  max: number
  defaultValue: number
  unit: string
  automatable: boolean
}

export interface PluginLayout {
  id: string
  name: string
  version: string
  controls: ControlLayout[]
}

/** JSON manifest. The web build loads `module` from the registry. A native build names a bundle instead of calling dlopen here. */
export interface PluginManifest {
  id: string
  name: string
  version: string
  category: 'insert' | 'instrument' | 'sequencer'
  module: string
  layout: PluginLayout
  /** Kind names when one module hosts several processors. Beat Machine is Sampler kind 1. */
  modes?: string[]
}

/**
 * Mirrors NativePluginBase. Methods stay free of host types so the same
 * calls can move to a shared DSP core later.
 */
export interface NativePlugin {
  prepare(sampleRate: number, maxBlockSize: number): void
  release(): void
  reset(): void
  processBlock(audio: AudioBlock, midi: MidiBlock): void
  setParameter(paramId: number, value: number): void
  getParameter(paramId: number): number
  getNumParameters(): number
  getLatencyInSamples(): number
  getState(): Uint8Array
  setState(data: Uint8Array): void
  layout(): PluginLayout
}
