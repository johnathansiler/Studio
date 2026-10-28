/**
 * Sample playback engine.
 *
 * The layered-patch builder can call:
 * - loadInstrument(def) to play a whole mapped instrument
 * - createSampleZoneVoice(zone, note, velocity) to play one zone it already chose
 *
 * Samples are not bundled. The bank keeps a short head in memory and reads later
 * pages from IndexedDB (or a test disk) when the playhead gets there.
 */
export { CHUNK_FRAMES, createDefaultDisk, createIdbDisk, createMemoryDisk, createStreamBank, instrumentBank } from './bank'
export type { DiskSample, DiskStore, MemoryDisk, SampleBank } from './bank'
export { SAMPLE_CONTROLS, controlsFor, controlValues, micControl } from './controls'
export { INTERP_RADIUS, readAt } from './interp'
export { loadInstrument, renderSampleProgram } from './load'
export type { LoadOptions, LoadedInstrument, SampleEvent } from './load'
export { keyswitchFor, rrGroupKey, selectZones, velocityLayerGain } from './map'
export type { SelectState } from './map'
export { emptyInstrumentDef, emptySampleProgram, programFromDef } from './program'
export type { Articulation, LoopMode, MicPosition, RoundRobinMode, SampleControl, SampleInstrumentDef, SampleMeta, SampleProgramState, SampleTrigger, SampleZone, ZonePick } from './types'
export { makeZone, clampNote, dbToGain, loopFromName, triggerFromName } from './zone'
export { createSampleZoneVoice } from './voice'
export type { SampleZoneVoice, VoiceOptions } from './voice'
