/**
 * One playback format for every library file.
 * Android Chrome follows the device clock. On the Z Fold that clock is 48 kHz,
 * and the screen recordings of the crunching 808 previews are 48 kHz too.
 * A 44.1 kHz or 96 kHz file has to be converted before it reaches the speaker.
 * 24-bit PCM WAV keeps a 24-bit master intact. Stereo is the one channel layout.
 */
export const LIBRARY_RATE = 48000
export const LIBRARY_BITS = 24
export const LIBRARY_CHANNELS = 2
export const LIBRARY_FORMAT = 'wav'

export function isLibraryStandard(file: { format?: string; sampleRate?: number; bits?: number; channels?: number }) {
  const format = (file.format || LIBRARY_FORMAT).toLowerCase()
  return format === LIBRARY_FORMAT
    && file.sampleRate === LIBRARY_RATE
    && file.bits === LIBRARY_BITS
    && file.channels === LIBRARY_CHANNELS
}
