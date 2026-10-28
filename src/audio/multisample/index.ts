/**
 * Multi-sample instrument.
 *
 * Other patch layers (sample + synth, granular, mod matrix, XY morph) should
 * build on this surface instead of the slice sampler:
 *
 * - `SamplerProgram` is the instrument, without PCM.
 * - `selectLayers()` maps a note onto zones, velocity, round-robin, keyswitch,
 *   release, and mic positions.
 * - `SamplerInstrument` renders those layers. Samples stream in through a `SampleBank`.
 * - `importInstrument()` reads SFZ, SF2, and DecentSampler from a user file.
 * - `fetchInstrument()` downloads one starter instrument from a Hugging Face dataset.
 *   Sample files stay on that host and load per note.
 */
export {
  clampMidi,
  dbToAmp,
  emptyAmpeg,
  emptyProgram,
  mainMic,
  makeProgram,
  makeSample,
  makeZone,
  midiVelocity,
  samplerId,
} from './types'
export type {
  Ampeg,
  DecodedSample,
  Keyswitch,
  LoopMode,
  MappedLayer,
  MapQuery,
  MapResult,
  MicPosition,
  SampleFormat,
  SampleLicense,
  SamplePack,
  SampleRef,
  SampleZone,
  SamplerProgram,
  ZoneTrigger,
} from './types'
export { isKeyswitch, selectLayers, tuneRatio } from './map'
export { MemoryBank, SampleCache, decodePacked, decodeSampleBytes } from './cache'
export type { SampleBank } from './cache'
export { SamplerInstrument, renderSampler } from './engine'
export type { SamplerNote } from './engine'
export { importSfz, parseNote } from './sfz'
export { importSoundFont } from './sf2'
export type { SoundFontImport } from './sf2'
export { importDecentSampler } from './dspreset'
export { absolutizeProgram, bindLocalSamples, importInstrument } from './import'
export type { ImportedInstrument, LocalSample } from './import'
export { STARTER_CATALOG, fetchCatalog, fetchInstrument, presetUrl, sampleUrl } from './library'
export type { LibraryEntry } from './library'
export {
  DEFAULT_LIBRARY_BASE,
  assertHuggingFaceUrl,
  libraryBaseUrl,
  libraryFileUrl,
  resolveSampleUrl,
  setLibraryBaseUrl,
} from './source'
export { LibraryHost } from './host'
