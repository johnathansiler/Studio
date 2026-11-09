import type { SamplerProgram } from '../audio/multisample/types'
import { soundCache, type SoundCache } from '../sounds/cache'
import { loadZoneSamples, samplesForNote } from './load'
import { factoryHarborPresets } from './presets'
import type { HarborInstrument } from './program'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HarborHost {
  setLibrary(trackId: string, program: SamplerProgram): void
  holdLibraryAudio?(trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]): void
  auditionLibrary?(trackId: string, pitch?: number, velocity?: number): Promise<void>
}

/**
 * Put one multi-sample instrument on a MIDI track.
 * Only the audition note's attack and release zones download. The rest wait until they are played.
 */
export async function installHarborInstrument(
  instrument: HarborInstrument,
  trackId: string,
  host: HarborHost,
  options?: { fetchImpl?: FetchLike; cache?: SoundCache; note?: number; velocity?: number; audition?: boolean },
) {
  const preset = factoryHarborPresets(instrument)[0]
  const articulations = instrument.articulations
  const program: SamplerProgram = {
    ...instrument.program,
    play: preset?.play ?? instrument.program.play,
    defaultSwitch: articulations.length > 1 ? Math.max(0, articulations.indexOf(preset?.articulation ?? articulations[0])) : null,
  }
  host.setLibrary(trackId, program)
  const zone = program.zones.find((item) => item.trigger !== 'release' && (program.defaultSwitch == null || item.swLast == null || item.swLast === program.defaultSwitch))
  const note = options?.note ?? zone?.root ?? 60
  const velocity = options?.velocity ?? 0.9
  const samples = samplesForNote(program, note, velocity)
  const decoded = await loadZoneSamples(samples, options?.fetchImpl, options?.cache ?? soundCache())
  if (decoded.length && host.holdLibraryAudio) host.holdLibraryAudio(trackId, decoded)
  if (options?.audition !== false && host.auditionLibrary) await host.auditionLibrary(trackId, note, velocity)
  return { program, note, velocity, loaded: decoded.length, requested: samples.length }
}
