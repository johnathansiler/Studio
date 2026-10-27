import { resampleSinc } from '../quality/resample'

/** Band-limited resize. Keeps the old name at the stem call sites. */
function resampleLinear(input: Float32Array, outLen: number) {
  return Float32Array.from(resampleSinc(input, outLen, 64))
}

/** HTDemucs ONNX segment. 7.8s at 44.1 kHz, matching the MIT export. */
export const MODEL_RATE = 44100
export const SEGMENT = 343980
export const OVERLAP = 0.25

/**
 * Seconds for one 7.8s chunk on a phone.
 * Browser WASM on this machine took 15.5s. A 4× CPU throttle, used as a phone stand-in, took 64s.
 * The sheet replaces this with the first chunk's real time on the device that is running it.
 */
export const WASM_CHUNK_SECONDS = 64

export const STEM_COLORS: Record<string, string> = {
  Vocals: '#ef6b6b',
  Drums: '#e0b15a',
  Bass: '#79b8d4',
  Other: '#73c48f',
  Guitar: '#f09a6a',
  Piano: '#c58be0',
  Instrumental: '#73c48f',
}

export type StemMode = 'vocals' | 'instrumental' | '2' | '4' | '6' | 'sampler'
export type StemQuality = 'fast' | 'high'

export interface StemModel {
  id: 'htdemucs' | 'htdemucs6'
  file: string
  url: string
  bytes: number
  stems: number
}

/** fp16-weight HTDemucs. Bytes are the Hugging Face content-length. Same file for vocals, 2-stem, and 4-stem. */
export const HTDEMUCS: StemModel = {
  id: 'htdemucs',
  file: 'htdemucs_fp16weights.onnx',
  url: 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx',
  bytes: 165612636,
  stems: 4,
}

export const HTDEMUCS_6: StemModel = {
  id: 'htdemucs6',
  file: 'htdemucs_6s_fp16weights.onnx',
  url: 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx',
  bytes: 136428532,
  stems: 6,
}

export function modelFor(mode: StemMode): StemModel {
  return mode === '6' ? HTDEMUCS_6 : HTDEMUCS
}

export function stemLabels(mode: StemMode): { name: string; color: string }[] {
  const names = mode === 'vocals'
    ? ['Vocals']
    : mode === 'instrumental'
      ? ['Instrumental']
      : mode === '2' || mode === 'sampler'
        ? ['Vocals', 'Instrumental']
        : mode === '6'
          ? ['Drums', 'Bass', 'Other', 'Vocals', 'Guitar', 'Piano']
          : ['Drums', 'Bass', 'Other', 'Vocals']
  return names.map((name) => ({ name, color: STEM_COLORS[name] ?? '#73c48f' }))
}

export interface StemBudget {
  maxStems: 2 | 4 | 6
  allowHigh: boolean
}

export function stemBudget(deviceMemory: number | undefined, phone: boolean, webgpu: boolean): StemBudget {
  const mem = deviceMemory ?? (phone ? 4 : 8)
  const maxStems: StemBudget['maxStems'] = mem <= 4 ? 2 : mem <= 8 ? 4 : 6
  return { maxStems, allowHigh: webgpu || (!phone && mem >= 8) }
}

export function modeRank(mode: StemMode) {
  if (mode === '6') return 6
  if (mode === '4') return 4
  return 2
}

export function modeAllowed(mode: StemMode, budget: StemBudget) {
  return modeRank(mode) <= budget.maxStems
}

export function shiftsFor(quality: StemQuality, budget: StemBudget) {
  return quality === 'high' && budget.allowHigh ? 2 : 0
}

export function formatBytes(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

export function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 50) return 'under a minute'
  const minutes = Math.max(1, Math.round(seconds / 60))
  return minutes === 1 ? 'about 1 min' : `about ${minutes} min`
}

export function chunkPlan(length: number, segment = SEGMENT, overlap = OVERLAP) {
  const stride = Math.max(1, Math.floor((1 - overlap) * segment))
  const offsets: number[] = []
  for (let offset = 0; offset < Math.max(1, length); offset += stride) offsets.push(offset)
  return { stride, offsets }
}

export function etaSeconds(durationSamples: number, sampleRate: number, shifts: number, secondsPerChunk = WASM_CHUNK_SECONDS) {
  const length = Math.max(1, Math.round((durationSamples * MODEL_RATE) / sampleRate))
  const passes = Math.max(1, shifts)
  return chunkPlan(length).offsets.length * passes * secondsPerChunk
}

/** Triangle used by Demucs overlap-add. Ends stay above zero so the blend divides cleanly. */
export function triangleWindow(segment: number) {
  const half = Math.floor(segment / 2)
  const raw = new Float32Array(segment)
  for (let i = 0; i < half; i++) raw[i] = i + 1
  for (let i = half; i < segment; i++) raw[i] = segment - i
  let peak = 1
  for (const value of raw) if (value > peak) peak = value
  const weight = new Float32Array(segment)
  for (let i = 0; i < segment; i++) weight[i] = raw[i] / peak
  return weight
}

export interface StemCheckpoint {
  mode: StemMode
  segment: number
  overlap: number
  modelLength: number
  targetLength: number
  mono: boolean
  stemCount: number
  shifts: number
  maxShift: number
  shiftIndex: number
  nextChunk: number
  passLength: number
  acc: Float32Array
  weight: Float32Array
  shiftSum: Float32Array | null
  doneShifts: number
}

export interface SeparateOptions {
  segment?: number
  overlap?: number
  shifts?: number
  maxShift?: number
  signal?: { cancelled: boolean }
  checkpoint?: StemCheckpoint
  onProgress?: (done: number, total: number) => void
}

type ModelRun = (stereo: [Float32Array, Float32Array]) => Promise<Float32Array[][]>

function at(stem: number, channel: number, index: number, channels: number, length: number) {
  return ((stem * channels + channel) * length) + index
}

function prepareMix(channels: Float32Array[], sampleRate: number) {
  const source = channels[0] ?? new Float32Array()
  const mono = channels.length < 2
  const length = sampleRate === MODEL_RATE ? source.length : Math.max(1, Math.round((source.length * MODEL_RATE) / sampleRate))
  const left = sampleRate === MODEL_RATE ? source : resampleLinear(source, length)
  const rightSource = channels[1] ?? source
  const right = sampleRate === MODEL_RATE ? rightSource : resampleLinear(rightSource, length)
  return { mix: [left, right] as [Float32Array, Float32Array], mono, modelLength: length, targetLength: source.length }
}

function modelWindow(mix: [Float32Array, Float32Array], offset: number, segment: number) {
  const total = mix[0].length
  const chunkLen = Math.max(0, Math.min(segment, total - offset))
  const delta = segment - chunkLen
  const start = offset - Math.floor(delta / 2)
  const end = start + segment
  const correctStart = Math.max(0, start)
  const correctEnd = Math.min(total, end)
  const padLeft = correctStart - start
  const input: [Float32Array, Float32Array] = [new Float32Array(segment), new Float32Array(segment)]
  input[0].set(mix[0].subarray(correctStart, correctEnd), padLeft)
  input[1].set(mix[1].subarray(correctStart, correctEnd), padLeft)
  return { input, valid: Math.max(0, chunkLen), trimLeft: Math.floor(delta / 2) }
}

function addStems(parts: Float32Array[][]) {
  const channels = parts[0]?.length ?? 0
  const length = parts[0]?.[0]?.length ?? 0
  const out = Array.from({ length: channels }, () => new Float32Array(length))
  for (const stem of parts) {
    for (let channel = 0; channel < channels; channel++) {
      const src = stem[channel]
      const dst = out[channel]
      if (!src || !dst) continue
      for (let i = 0; i < length; i++) dst[i] += src[i] ?? 0
    }
  }
  return out
}

function reduceChunk(model: Float32Array[][], mode: StemMode): Float32Array[][] {
  const vocals = model[3]
  if (!vocals) throw new Error('The model returned too few stems')
  if (mode === 'vocals') return [vocals]
  const rest = addStems(model.filter((_, index) => index !== 3))
  if (mode === 'instrumental') return [rest]
  if (mode === '2' || mode === 'sampler') return [vocals, rest]
  return model
}

function readStems(flat: Float32Array, stemCount: number, length: number): Float32Array[][] {
  const stems: Float32Array[][] = []
  for (let stem = 0; stem < stemCount; stem++) {
    const channels: Float32Array[] = []
    for (let channel = 0; channel < 2; channel++) {
      const start = at(stem, channel, 0, 2, length)
      channels.push(flat.subarray(start, start + length))
    }
    stems.push(channels)
  }
  return stems
}

function normalize(flat: Float32Array, weight: Float32Array, stemCount: number) {
  const length = weight.length
  for (let i = 0; i < length; i++) {
    const scale = weight[i] ?? 0
    if (!(scale > 0)) throw new Error('A chunk boundary has no overlap weight')
    for (let stem = 0; stem < stemCount; stem++) {
      for (let channel = 0; channel < 2; channel++) {
        const index = at(stem, channel, i, 2, length)
        flat[index] = (flat[index] ?? 0) / scale
      }
    }
  }
}

function shiftedMix(mix: [Float32Array, Float32Array], maxShift: number, offset: number): [Float32Array, Float32Array] {
  const length = mix[0].length
  const shiftedLen = length + maxShift - offset
  return [0, 1].map((channel) => {
    const padded = new Float32Array(length + 2 * maxShift)
    padded.set(mix[channel] ?? new Float32Array(), maxShift)
    return padded.subarray(offset, offset + shiftedLen)
  }) as [Float32Array, Float32Array]
}

function foldPass(pass: Float32Array, shiftSum: Float32Array, stemCount: number, passLength: number, modelLength: number, start: number) {
  for (let stem = 0; stem < stemCount; stem++) {
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < modelLength; i++) {
        const from = at(stem, channel, start + i, 2, passLength)
        const to = at(stem, channel, i, 2, modelLength)
        shiftSum[to] = (shiftSum[to] ?? 0) + (pass[from] ?? 0)
      }
    }
  }
}

export async function separateMix(
  channels: Float32Array[],
  sampleRate: number,
  mode: StemMode,
  run: ModelRun,
  options: SeparateOptions = {},
): Promise<{ stems: Float32Array[][] | null; checkpoint: StemCheckpoint | null }> {
  const prepared = prepareMix(channels, sampleRate)
  const segment = options.segment ?? SEGMENT
  const overlap = options.overlap ?? OVERLAP
  const labels = stemLabels(mode)
  const stemCount = labels.length
  const shifts = Math.max(0, options.shifts ?? 0)
  const passes = Math.max(1, shifts)
  const maxShift = shifts > 0 ? Math.max(0, options.maxShift ?? Math.floor(MODEL_RATE / 2)) : 0
  const saved = options.checkpoint
  const planFor = (length: number) => chunkPlan(length, segment, overlap)
  const totalChunks = planFor(shifts > 0 ? prepared.modelLength + maxShift : prepared.modelLength).offsets.length * passes
  let shiftIndex = saved?.shiftIndex ?? 0
  let nextChunk = saved?.nextChunk ?? 0
  let doneShifts = saved?.doneShifts ?? 0
  let shiftSum = saved?.shiftSum ?? null
  let acc = saved?.acc ?? null
  let weight = saved?.weight ?? null
  let passLength = saved?.passLength ?? 0
  const window = triangleWindow(segment)
  const signal = options.signal
  let completed = shiftIndex * planFor(prepared.modelLength).offsets.length + nextChunk

  const report = () => options.onProgress?.(completed, Math.max(1, totalChunks))

  while (shiftIndex < passes) {
    const offset = shifts > 0 ? Math.floor((shiftIndex * maxShift) / passes) : 0
    const mix = shifts > 0 ? shiftedMix(prepared.mix, maxShift, offset) : prepared.mix
    passLength = mix[0].length
    if (!acc || acc.length !== stemCount * 2 * passLength) {
      acc = new Float32Array(stemCount * 2 * passLength)
      weight = new Float32Array(passLength)
      nextChunk = 0
    }
    const offsets = planFor(passLength).offsets
    const scale = weight ?? new Float32Array(passLength)
    for (let index = nextChunk; index < offsets.length; index++) {
      const chunkOffset = offsets[index] ?? 0
      const chunk = modelWindow(mix, chunkOffset, segment)
      const model = await run(chunk.input)
      if (model.length < (mode === '6' ? 6 : 4)) throw new Error('The model returned too few stems')
      const reduced = reduceChunk(model, mode)
      for (let stem = 0; stem < stemCount; stem++) {
        for (let channel = 0; channel < 2; channel++) {
          const trimmed = reduced[stem]?.[channel]
          if (!trimmed) continue
          const body = trimmed.subarray(chunk.trimLeft, chunk.trimLeft + chunk.valid)
          for (let i = 0; i < chunk.valid; i++) {
            const sample = (body[i] ?? 0) * (window[i] ?? 0)
            acc[at(stem, channel, chunkOffset + i, 2, passLength)] += sample
          }
        }
      }
      for (let i = 0; i < chunk.valid; i++) scale[chunkOffset + i] = (scale[chunkOffset + i] ?? 0) + (window[i] ?? 0)
      nextChunk = index + 1
      completed += 1
      report()
      if (signal?.cancelled) {
        return {
          stems: null,
          checkpoint: {
            mode, segment, overlap, modelLength: prepared.modelLength, targetLength: prepared.targetLength,
            mono: prepared.mono, stemCount, shifts, maxShift, shiftIndex, nextChunk, passLength,
            acc, weight: scale, shiftSum, doneShifts,
          },
        }
      }
    }
    normalize(acc, scale, stemCount)
    if (shifts > 0) {
      if (!shiftSum) shiftSum = new Float32Array(stemCount * 2 * prepared.modelLength)
      foldPass(acc, shiftSum, stemCount, passLength, prepared.modelLength, maxShift - offset)
      doneShifts += 1
      acc = null
      weight = null
      nextChunk = 0
    }
    shiftIndex += 1
  }

  const flat = shifts > 0 ? shiftSum ?? new Float32Array(stemCount * 2 * prepared.modelLength) : acc ?? new Float32Array()
  if (shifts > 0) {
    const divisor = Math.max(1, doneShifts)
    for (let i = 0; i < flat.length; i++) flat[i] = (flat[i] ?? 0) / divisor
  }
  let stems = readStems(flat, stemCount, prepared.modelLength).map((stem) => stem.map((channel) => Float32Array.from(channel)))
  if (sampleRate !== MODEL_RATE || stems[0]?.[0]?.length !== prepared.targetLength) {
    stems = stems.map((stem) => stem.map((channel) => resampleLinear(channel, prepared.targetLength)))
  }
  if (prepared.mono) {
    stems = stems.map((stem) => {
      const left = stem[0] ?? new Float32Array(prepared.targetLength)
      const right = stem[1] ?? left
      const mixed = new Float32Array(left.length)
      for (let i = 0; i < mixed.length; i++) mixed[i] = ((left[i] ?? 0) + (right[i] ?? 0)) / 2
      return [mixed]
    })
  }
  return { stems, checkpoint: null }
}
