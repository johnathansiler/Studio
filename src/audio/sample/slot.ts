import { resampleSinc } from '../quality/resample'
import { musicCaptureAttempts } from '../../model/codecs'
import { uid, type AudioAsset, type AudioClip, type PluginInstance, type Project, type SampleZone, type SamplerState } from '../../model/types'
import { countInSeconds, type TimeSignature } from '../../model/time'
import { decodeFlac } from '../../model/flac'
import { decodeWavPCM, parseWavHeader } from '../../model/wav'
import { detectRoot, syncedLoopSamples, type LooperState } from './engine'

/** Extensions and MIME types the Android and iPhone file pickers both offer. */
export const SLOT_ACCEPT = [
  'audio/*',
  '.wav', '.wave', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.aiff', '.aif',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/ogg',
  'audio/flac', 'audio/x-flac', 'audio/aiff', 'audio/x-aiff',
].join(',')

export const SOUND_MIME = 'application/x-cueharbor-sound'
export const OPEN_SOUNDS = 'cueharbor-open-sounds'
export const SLOT_CLIP = 'cueharbor-slot-clip'

export interface SlotPoints {
  start: number
  end: number
  loopStart: number
  loopEnd: number
}

export interface DecodedAudio {
  sampleRate: number
  channels: Float32Array[]
  bits: number
}

export interface CaptureSource {
  readonly sampleRate: number
  /** Start delivering copied frames. The returned function stops delivery. */
  start(onFrame: (frame: Float32Array) => void): Promise<() => void> | (() => void)
}

export interface CaptureControl {
  shouldStop: () => boolean
  onLevel: (level: number) => void
  onPhase: (phase: 'count-in' | 'recording', beat?: number) => void
  wait: (ms: number) => Promise<void>
  click?: (beat: number) => void
}

const AUDIO_RATES = new Set([8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000])

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Keep every handle inside the file, with the loop inside the trim window. */
export function clampSlotPoints(points: SlotPoints): SlotPoints {
  const start = clamp01(points.start)
  const end = Math.min(1, Math.max(start + 0.01, clamp01(points.end)))
  const loopStart = Math.min(end - 0.01, Math.max(start, clamp01(points.loopStart)))
  const loopEnd = Math.min(end, Math.max(loopStart + 0.01, clamp01(points.loopEnd)))
  return { start, end, loopStart, loopEnd }
}

export function readSlotPoints(source: Partial<SlotPoints> | null | undefined): SlotPoints {
  return clampSlotPoints({
    start: source?.start ?? 0,
    end: source?.end ?? 1,
    loopStart: source?.loopStart ?? source?.start ?? 0,
    loopEnd: source?.loopEnd ?? source?.end ?? 1,
  })
}

export function dragSlotPoint(points: SlotPoints, which: keyof SlotPoints, ratio: number): SlotPoints {
  return clampSlotPoints({ ...points, [which]: ratio })
}

export function peakLevel(frame: Float32Array) {
  let peak = 0
  for (let i = 0; i < frame.length; i++) {
    const value = Math.abs(frame[i] || 0)
    if (value > peak) peak = value
  }
  return Math.min(1, peak)
}

export function concatFrames(frames: Float32Array[]) {
  let length = 0
  for (const frame of frames) length += frame.length
  const out = new Float32Array(length)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/**
 * Record from an already-open source. Count-in frames update the meter and
 * are not kept. Nothing here resamples or compresses the captured samples.
 */
export async function captureSlot(
  source: CaptureSource,
  options: { countIn: boolean; tempo: number; signature: TimeSignature; maxSamples: number },
  control: CaptureControl,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const kept: Float32Array[] = []
  let total = 0
  let armed = !options.countIn
  const stop = await source.start((frame) => {
    const copy = Float32Array.from(frame)
    control.onLevel(peakLevel(copy))
    if (!armed) return
    if (options.maxSamples > 0 && total >= options.maxSamples) return
    const room = options.maxSamples > 0 ? options.maxSamples - total : copy.length
    const take = room < copy.length ? copy.subarray(0, room) : copy
    const owned = take === copy ? copy : Float32Array.from(take)
    kept.push(owned)
    total += owned.length
  })
  if (options.countIn) {
    const beats = Math.max(1, Math.round(options.signature.numerator) || 1)
    const beatMs = (countInSeconds(options.tempo, options.signature) / beats) * 1000
    for (let beat = 0; beat < beats; beat++) {
      if (control.shouldStop()) {
        stop()
        return null
      }
      control.onPhase('count-in', beats - beat)
      control.click?.(beat)
      await control.wait(beatMs)
    }
    if (control.shouldStop()) {
      stop()
      return null
    }
  }
  armed = true
  control.onPhase('recording')
  while (!control.shouldStop() && !(options.maxSamples > 0 && total >= options.maxSamples)) {
    await control.wait(40)
  }
  stop()
  if (!total) return null
  return { channels: [concatFrames(kept)], sampleRate: source.sampleRate }
}

/** Play a file at the engine rate without touching the stored samples. */
export function playbackChannel(channel: Float32Array, fromRate: number, toRate: number) {
  if (!(fromRate > 0) || !(toRate > 0) || fromRate === toRate) return channel
  const outLen = Math.max(1, Math.round((channel.length * toRate) / fromRate))
  const taps = channel.length > fromRate * 90 ? 24 : 96
  return resampleSinc(channel, outLen, taps)
}

export function fitLoopBuffer(channel: Float32Array, sampleRate: number, sync: boolean, bars: number, tempo: number, numerator: number) {
  if (!sync) return channel
  const target = syncedLoopSamples(bars, tempo, sampleRate, numerator)
  if (channel.length === target) return channel
  const out = new Float32Array(target)
  out.set(channel.subarray(0, Math.min(channel.length, target)))
  return out
}

/** Match an overdub to the loop's rate and length. Same-rate audio is copied, not resampled. */
export function fitOverdub(channel: Float32Array, fromRate: number, toRate: number, length: number) {
  const matched = fromRate === toRate ? channel : playbackChannel(channel, fromRate, toRate)
  const target = Math.max(1, length)
  if (matched.length === target && fromRate === toRate) return matched
  const out = new Float32Array(target)
  out.set(matched.subarray(0, Math.min(matched.length, target)))
  return out
}

function fitAll(channels: Float32Array[], target: number) {
  return channels.map((channel) => {
    if (channel.length === target) return channel
    const out = new Float32Array(target)
    out.set(channel.subarray(0, Math.min(channel.length, target)))
    return out
  })
}

export function placeSampler(sampler: SamplerState, asset: AudioAsset) {
  const channel = asset.channels[0]
  sampler.bufferId = asset.id
  sampler.sourceRate = asset.sampleRate
  sampler.start = 0
  sampler.end = 1
  sampler.loopStart = 0
  sampler.loopEnd = 1
  sampler.slices = []
  if (channel?.length) sampler.root = detectRoot(channel, asset.sampleRate)
}

export function placeLooper(
  looper: LooperState,
  asset: AudioAsset,
  mode: 'replace' | 'overdub',
  project: Pick<Project, 'tempo' | 'timeSignature'>,
): AudioAsset {
  const lead = asset.channels[0] ?? new Float32Array(0)
  const fresh = mode === 'replace' || looper.layers.length === 0
  if (fresh) {
    const fitted = fitLoopBuffer(lead, asset.sampleRate, looper.sync !== false, looper.bars || 1, project.tempo, project.timeSignature.numerator)
    const stored: AudioAsset = fitted === lead
      ? asset
      : { ...asset, channels: fitAll(asset.channels.length ? asset.channels : [lead], fitted.length) }
    looper.layers = [{ id: uid('lyr'), bufferId: stored.id, gain: 1, mute: false, reverse: false, speed: 1 }]
    looper.undone = []
    looper.lengthSamples = fitted.length
    looper.sourceRate = stored.sampleRate
    looper.start = 0
    looper.end = 1
    looper.loopStart = 0
    looper.loopEnd = 1
    looper.transport = 1
    return stored
  }
  const targetRate = looper.sourceRate && looper.sourceRate > 0 ? looper.sourceRate : asset.sampleRate
  const length = looper.lengthSamples || lead.length || 1
  const fitted = fitOverdub(lead, asset.sampleRate, targetRate, length)
  const stored: AudioAsset = {
    id: asset.id,
    name: asset.name || 'Overdub',
    sampleRate: targetRate,
    channels: [fitted],
  }
  looper.layers = [...looper.layers, { id: uid('lyr'), bufferId: stored.id, gain: 1, mute: false, reverse: false, speed: 1 }]
  looper.undone = []
  looper.lengthSamples = length
  looper.transport = 1
  return stored
}

/** Copy the arrange clip's audible region. The sample rate and samples stay as stored. */
export function assetFromClip(asset: AudioAsset, clip: Pick<AudioClip, 'name' | 'offsetSamples' | 'durationSamples'>, id: string): AudioAsset | null {
  const lead = asset.channels[0]
  if (!lead || lead.length < 2) return null
  const start = Math.max(0, Math.min(lead.length - 2, Math.round(clip.offsetSamples) || 0))
  const span = Math.max(2, Math.round(clip.durationSamples) || lead.length - start)
  const end = Math.max(start + 2, Math.min(lead.length, start + span))
  return {
    id,
    name: clip.name || asset.name,
    sampleRate: asset.sampleRate,
    channels: asset.channels.map((channel) => channel.slice(start, Math.min(channel.length, end))),
  }
}

export function retargetSlices(slices: SampleZone[], root: number): SampleZone[] {
  const base = Math.max(0, Math.min(127, Math.round(root)))
  return slices.map((slice, index) => {
    const note = Math.min(127, base + index)
    const lo = index === 0 ? 0 : note
    const hi = index === slices.length - 1 ? 127 : note
    return { ...slice, root: note, lo, hi }
  })
}

export function focusedSlot(store: { pluginFocus: { trackId: string; pluginId: string } | null; project: Project }): { trackId: string; pluginId: string; kind: 'sampler' | 'looper' } | null {
  const focus = store.pluginFocus
  if (!focus) return null
  const list = focus.trackId === 'master' ? store.project.masterPlugins : store.project.tracks.find((track) => track.id === focus.trackId)?.plugins
  const plugin = list?.find((item) => item.id === focus.pluginId)
  if (!plugin) return null
  if (plugin.pluginId !== 'sampler' && plugin.pluginId !== 'looper') return null
  return { trackId: focus.trackId, pluginId: focus.pluginId, kind: plugin.pluginId }
}

export function slotKind(plugin: PluginInstance): 'sampler' | 'looper' | null {
  if (plugin.pluginId === 'sampler' || plugin.sampler) return plugin.pluginId === 'looper' ? 'looper' : 'sampler'
  if (plugin.pluginId === 'looper' || plugin.looper) return 'looper'
  return null
}

/** Lossless decode for WAV, our FLAC subset, and uncompressed AIFF. Compressed files return null. */
export function decodeSlotBytes(bytes: ArrayBuffer): DecodedAudio | null {
  if (bytes.byteLength < 12) return null
  const head = new Uint8Array(bytes, 0, 12)
  const kind = ascii(head, 0, 4)
  if (kind === 'RIFF' && ascii(head, 8, 4) === 'WAVE') {
    const wav = decodeWavPCM(bytes)
    let bits = 16
    try { bits = parseWavHeader(bytes).bits } catch { /* the PCM reader already checked the header */ }
    return { sampleRate: wav.sampleRate, channels: wav.channels, bits }
  }
  if (kind === 'fLaC') {
    try {
      const flac = decodeFlac(new Uint8Array(bytes))
      if (!flac.channels[0]?.length) return null
      return { sampleRate: flac.sampleRate, channels: flac.channels, bits: 16 }
    } catch {
      return null
    }
  }
  if (kind === 'FORM' && (ascii(head, 8, 4) === 'AIFF' || ascii(head, 8, 4) === 'AIFC')) return decodeAiff(bytes)
  return null
}

export async function decodeSlotFile(bytes: ArrayBuffer, decodeNative: (bytes: ArrayBuffer, sampleRate: number | null) => Promise<DecodedAudio> = browserDecode): Promise<DecodedAudio> {
  const direct = decodeSlotBytes(bytes)
  if (direct?.channels[0]?.length) return copyDecoded(direct)
  const sniffed = sniffCompressedRate(new Uint8Array(bytes))
  return copyDecoded(await decodeNative(bytes, sniffed))
}

export async function browserDecode(bytes: ArrayBuffer, sampleRate: number | null): Promise<DecodedAudio> {
  if (typeof AudioContext === 'undefined') throw new Error('This browser cannot decode that audio file.')
  const wanted = sampleRate && AUDIO_RATES.has(sampleRate) ? sampleRate : undefined
  let ctx: AudioContext
  try {
    ctx = new AudioContext(wanted ? { sampleRate: wanted } : undefined)
  } catch {
    ctx = new AudioContext()
  }
  try {
    const decoded = await ctx.decodeAudioData(bytes.slice(0))
    return {
      sampleRate: decoded.sampleRate,
      bits: 32,
      channels: Array.from({ length: decoded.numberOfChannels }, (_, index) => Float32Array.from(decoded.getChannelData(index))),
    }
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

function copyDecoded(decoded: DecodedAudio): DecodedAudio {
  return {
    sampleRate: decoded.sampleRate,
    bits: decoded.bits,
    channels: decoded.channels.map((channel) => Float32Array.from(channel)),
  }
}

export function sniffCompressedRate(bytes: Uint8Array): number | null {
  const mp3 = sniffMp3Rate(bytes)
  if (mp3) return mp3
  return sniffMp4Rate(bytes)
}

function sniffMp3Rate(bytes: Uint8Array) {
  const mpeg1 = [44100, 48000, 32000]
  const mpeg2 = [22050, 24000, 16000]
  const mpeg25 = [11025, 12000, 8000]
  const end = Math.min(bytes.length - 3, 65536)
  for (let i = 0; i < end; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue
    const version = (bytes[i + 1] >> 3) & 3
    const layer = (bytes[i + 1] >> 1) & 3
    const index = (bytes[i + 2] >> 2) & 3
    if (index > 2 || layer === 0 || version === 1) continue
    const table = version === 3 ? mpeg1 : version === 2 ? mpeg2 : mpeg25
    return table[index] ?? null
  }
  return null
}

function sniffMp4Rate(bytes: Uint8Array) {
  const end = Math.min(bytes.length - 24, 2_000_000)
  for (let i = 4; i < end; i++) {
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x64 || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue
    const version = bytes[i + 4]
    const scaleAt = version === 1 ? i + 4 + 4 + 16 + 16 : i + 4 + 4 + 8 + 8
    if (scaleAt + 4 > bytes.length) continue
    const view = new DataView(bytes.buffer, bytes.byteOffset + scaleAt, 4)
    const rate = view.getUint32(0, false)
    if (AUDIO_RATES.has(rate)) return rate
  }
  return null
}

export function decodeAiff(bytes: ArrayBuffer): DecodedAudio | null {
  const view = new DataView(bytes)
  if (ascii(new Uint8Array(bytes, 0, 12), 8, 4) !== 'AIFF' && ascii(new Uint8Array(bytes, 0, 12), 8, 4) !== 'AIFC') return null
  let channels = 0
  let frames = 0
  let bits = 0
  let sampleRate = 0
  let little = false
  let float = false
  let dataOffset = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(new Uint8Array(bytes, offset, 4), 0, 4)
    const size = view.getUint32(offset + 4, false)
    const start = offset + 8
    if (id === 'COMM' && start + 18 <= bytes.byteLength) {
      channels = view.getInt16(start, false)
      frames = view.getUint32(start + 2, false)
      bits = view.getInt16(start + 6, false)
      sampleRate = Math.round(readExtended(view, start + 8))
      if (ascii(new Uint8Array(bytes, 0, 12), 8, 4) === 'AIFC' && start + 22 <= bytes.byteLength) {
        const comp = ascii(new Uint8Array(bytes, start + 18, 4), 0, 4)
        if (comp === 'sowt') little = true
        else if (comp === 'fl32' || comp === 'FL32') float = true
        else if (comp !== 'NONE' && comp !== 'twos' && comp !== 'in16' && comp !== 'in24' && comp !== 'in32') return null
      }
    } else if (id === 'SSND' && start + 8 <= bytes.byteLength) {
      const skip = view.getUint32(start, false)
      dataOffset = start + 8 + skip
      dataBytes = Math.max(0, size - 8 - skip)
    }
    offset += 8 + size + (size % 2)
  }
  if (channels < 1 || frames < 1 || !sampleRate || dataOffset <= 0) return null
  const bytesPer = float ? 4 : bits === 24 ? 3 : bits === 32 ? 4 : bits === 16 ? 2 : bits === 8 ? 1 : 0
  if (!bytesPer) return null
  const count = Math.min(frames, Math.floor(dataBytes / (channels * bytesPer)))
  if (count < 1) return null
  const out = Array.from({ length: channels }, () => new Float32Array(count))
  let pos = dataOffset
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = readAiffSample(view, pos, bits, little, float)
      pos += bytesPer
    }
  }
  return { sampleRate, channels: out, bits: float ? 32 : bits }
}

function readAiffSample(view: DataView, offset: number, bits: number, little: boolean, float: boolean) {
  if (offset + (float || bits === 32 ? 4 : bits === 24 ? 3 : bits === 8 ? 1 : 2) > view.byteLength) return 0
  if (float) return view.getFloat32(offset, little)
  if (bits === 8) return (view.getUint8(offset) - 128) / 128
  if (bits === 24) {
    const b0 = view.getUint8(offset)
    const b1 = view.getUint8(offset + 1)
    const b2 = view.getUint8(offset + 2)
    const code = little ? (b0 | (b1 << 8) | (b2 << 16)) : ((b0 << 16) | (b1 << 8) | b2)
    const signed = code & 0x800000 ? code - 0x1000000 : code
    return signed < 0 ? signed / 0x800000 : signed / 0x7fffff
  }
  if (bits === 32) {
    const code = view.getInt32(offset, little)
    return code < 0 ? code / 0x80000000 : code / 0x7fffffff
  }
  const code = view.getInt16(offset, little)
  return code < 0 ? code / 0x8000 : code / 0x7fff
}

function readExtended(view: DataView, offset: number) {
  const sign = view.getUint8(offset) >> 7
  const exp = ((view.getUint8(offset) & 0x7f) << 8) | view.getUint8(offset + 1)
  let mantissa = 0
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + view.getUint8(offset + 2 + i)
  if ((exp === 0 && mantissa === 0) || exp === 0x7fff) return 0
  const value = mantissa * 2 ** (exp - 16383 - 63)
  return sign ? -value : value
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i] || 0)
  return text
}

export interface CaptureContext {
  sampleRate: number
  destination: unknown
  createMediaStreamSource(stream: MediaStream): Connectable
  createGain(): GainLike
  createScriptProcessor(size: number, inputs: number, outputs: number): ProcessorLike
  createChannelSplitter?(count: number): Connectable
}

interface Connectable {
  connect(node: unknown, output?: number, input?: number): void
  disconnect(): void
}

interface GainLike extends Connectable {
  gain: { value: number }
}

/** Parameter checks stay bivariant so a browser AudioContext and a test double both fit. */
type AudioCallback<T extends (...args: never[]) => void> = { bivarianceHack(...args: Parameters<T>): void }['bivarianceHack']

interface ProcessorLike extends Connectable {
  onaudioprocess: AudioCallback<(event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void> | null
}

export interface OpenInputOptions {
  deviceId: string
  stream: MediaStream | null
  context: CaptureContext
  channel: number | null
  request: (constraints: true | MediaTrackConstraints) => Promise<MediaStream>
}

export interface InputCapture {
  source: CaptureSource
  stream: MediaStream
  /** True when this capture opened a stream that it should stop. */
  opened: boolean
  close: () => void
}

function liveStream(stream: MediaStream | null) {
  return !!stream && stream.getAudioTracks().some((track) => track.readyState === 'live')
}

/**
 * Wire the selected microphone into a float capture.
 * An existing live stream is used first. Otherwise the selected device id is requested.
 * Frames are copied out of the audio callback so later callbacks cannot overwrite them.
 */
export async function openInputCapture(options: OpenInputOptions): Promise<InputCapture> {
  let stream = liveStream(options.stream) ? options.stream : null
  let opened = false
  if (!stream) {
    let last: unknown
    for (const attempt of musicCaptureAttempts(options.deviceId)) {
      try {
        stream = await options.request(attempt)
        opened = true
        break
      } catch (error) {
        last = error
      }
    }
    if (!stream) throw last instanceof Error ? last : new Error('Could not open the microphone.')
  }
  const src = options.context.createMediaStreamSource(stream)
  const silent = options.context.createGain()
  silent.gain.value = 0
  const proc = options.context.createScriptProcessor(2048, 1, 1)
  let splitter: Connectable | null = null
  if (options.channel != null && options.context.createChannelSplitter) {
    splitter = options.context.createChannelSplitter(options.channel + 1)
    src.connect(splitter)
    splitter.connect(proc, options.channel, 0)
  } else src.connect(proc)
  proc.connect(silent)
  silent.connect(options.context.destination)
  let handler: ((frame: Float32Array) => void) | null = null
  proc.onaudioprocess = (event) => {
    if (!handler) return
    handler(Float32Array.from(event.inputBuffer.getChannelData(0)))
  }
  const source: CaptureSource = {
    sampleRate: options.context.sampleRate,
    start(onFrame) {
      handler = onFrame
      return () => { handler = null }
    },
  }
  return {
    source,
    stream,
    opened,
    close() {
      handler = null
      try { proc.disconnect() } catch { /* already stopped */ }
      try { splitter?.disconnect() } catch { /* already stopped */ }
      try { src.disconnect() } catch { /* already stopped */ }
      try { silent.disconnect() } catch { /* already stopped */ }
      if (opened) stream?.getTracks().forEach((track) => track.stop())
    },
  }
}

export function micChannel(input: string | undefined) {
  const match = /^mic:(\d+)$/.exec(input || '')
  return match ? Number(match[1]) : null
}

let rememberedDevice = ''
let rememberedStream: MediaStream | null = null

/** The session publishes the mic the user picked. The slot recorder reads it back. */
export function rememberSlotInput(deviceId: string, stream: MediaStream | null) {
  rememberedDevice = deviceId || ''
  rememberedStream = stream
}

export function rememberedSlotInput() {
  return { deviceId: rememberedDevice, stream: rememberedStream }
}
