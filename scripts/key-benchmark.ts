/**
 * Read-only key benchmark.
 *
 * Compares Detect's existing detector with loops that already have a key,
 * then scores it on ground truth that does not come from those tags:
 * rendered progressions, the #298 formant shifter, and GiantSteps+ EDM.
 * It does not change the detector, write key tags, or upload audio.
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectKey, type KeyReading } from '../src/analysis/clipKey.ts'
import { monoMix } from '../src/analysis/mix.ts'
import { formantPitchChannels } from '../src/audio/stretch/formantPitch.ts'
import { instrumentFileUrl } from '../src/harbor/load.ts'
import { keyFromFilename, keyFromText, parseMusicalKey, resolveEntryKey, type MusicalKey } from '../src/library/musicalKey.ts'
import { soundFileUrl } from '../src/sounds/source.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = '/opt/cursor/artifacts/key-benchmark'
const cacheDir = '/tmp/key-benchmark/cache'
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SR = 48000

type Mode = 'major' | 'minor'
type Relation = 'exact' | 'parallel' | 'relative' | 'fifth' | 'semitone' | 'other' | 'no-clear-key' | 'excluded'

interface Scored {
  root: number
  mode: Mode
  label: string
}

interface Verdict {
  relation: Relation
  mirex: number
  semitones: number | null
}

function labelOf(root: number, mode: Mode) {
  return `${NAMES[(root + 12) % 12]} ${mode}`
}

function scored(root: number, mode: Mode): Scored {
  const pc = (root + 12) % 12
  return { root: pc, mode, label: labelOf(pc, mode) }
}

/** MIREX since 2017: fifths in either direction score 0.5. Same-mode only. */
function verdict(truth: Scored | null, heard: Scored | null): Verdict {
  if (!truth) return { relation: 'excluded', mirex: 0, semitones: null }
  if (!heard) return { relation: 'no-clear-key', mirex: 0, semitones: null }
  const up = (heard.root - truth.root + 12) % 12
  if (up === 0 && heard.mode === truth.mode) return { relation: 'exact', mirex: 1, semitones: 0 }
  if (up === 0 && heard.mode !== truth.mode) return { relation: 'parallel', mirex: 0.2, semitones: 0 }
  if (heard.mode !== truth.mode && truth.mode === 'major' && up === 9) return { relation: 'relative', mirex: 0.3, semitones: up }
  if (heard.mode !== truth.mode && truth.mode === 'minor' && up === 3) return { relation: 'relative', mirex: 0.3, semitones: up }
  if (heard.mode === truth.mode && (up === 7 || up === 5)) return { relation: 'fifth', mirex: 0.5, semitones: up }
  if (up === 1 || up === 11) return { relation: 'semitone', mirex: 0, semitones: up === 11 ? -1 : 1 }
  return { relation: 'other', mirex: 0, semitones: up > 6 ? up - 12 : up }
}

function assertScore(name: string, got: number, want: number) {
  if (Math.abs(got - want) > 1e-9) throw new Error(`${name}: ${got} !== ${want}`)
}

function selfCheck() {
  const cMaj = scored(0, 'major')
  const aMin = scored(9, 'minor')
  const cMin = scored(0, 'minor')
  const gMaj = scored(7, 'major')
  const fMaj = scored(5, 'major')
  const csMaj = scored(1, 'major')
  assertScore('exact', verdict(cMaj, cMaj).mirex, 1)
  assertScore('relative', verdict(cMaj, aMin).mirex, 0.3)
  assertScore('relative-back', verdict(aMin, cMaj).mirex, 0.3)
  assertScore('parallel', verdict(cMaj, cMin).mirex, 0.2)
  assertScore('fifth-up', verdict(cMaj, gMaj).mirex, 0.5)
  assertScore('fifth-down', verdict(cMaj, fMaj).mirex, 0.5)
  assertScore('semitone', verdict(cMaj, csMaj).mirex, 0)
  if (verdict(cMaj, null).relation !== 'no-clear-key') throw new Error('missing hearing')
}

function heardFrom(reading: KeyReading): Scored | null {
  if (!reading.clear || reading.root == null || (reading.scale !== 'ionian' && reading.scale !== 'aeolian')) return null
  return scored(reading.root, reading.scale === 'aeolian' ? 'minor' : 'major')
}

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function writeCsv(path: string, rows: Record<string, unknown>[]) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','))
  return writeFile(path, `${lines.join('\n')}\n`)
}

function mean(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000
}

function tally(rows: { relation: string; mirex: number }[]) {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.relation] = (counts[row.relation] ?? 0) + 1
  const n = rows.length
  const exact = counts.exact ?? 0
  return {
    n,
    exact,
    exactRate: n ? round3(exact / n) : 0,
    mirex: round3(mean(rows.map((row) => row.mirex))),
    counts,
  }
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const out: Record<string, ReturnType<typeof tally>> = {}
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const name = key(row) || '(blank)'
    const list = buckets.get(name) ?? []
    list.push(row)
    buckets.set(name, list)
  }
  for (const [name, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[name] = tally(list as { relation: string; mirex: number }[])
  }
  return out
}

function calibration(rows: { clear: boolean; confidence: number; relation: string; mirex: number }[]) {
  const edges = [0, 0.32, 0.45, 0.55, 0.65, 0.75, 0.85, 1.01]
  const bins = []
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]
    const hi = edges[i + 1]
    const slice = rows.filter((row) => row.confidence >= lo && row.confidence < hi)
    bins.push({ lo, hi: hi > 1 ? 1 : hi, ...tally(slice) })
  }
  const thresholds = []
  for (const threshold of [0.32, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    const kept = rows.filter((row) => row.clear && row.confidence >= threshold)
    const exact = kept.filter((row) => row.relation === 'exact').length
    thresholds.push({
      threshold,
      accepted: kept.length,
      precision: kept.length ? round3(exact / kept.length) : 0,
      recall: rows.length ? round3(exact / rows.length) : 0,
      mirex: round3(mean(kept.map((row) => row.mirex))),
    })
  }
  const precise = thresholds.find((row) => row.precision >= 0.95 && row.accepted >= 15)
  return { bins, thresholds, thresholdFor95Precision: precise ?? null }
}

async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index], index)
    }
  }
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, () => run()))
}

function decodeWavWindow(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  if (buffer.byteLength < 44) throw new Error('short wav')
  const word = (offset: number, length: number) => {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i))
    return text
  }
  if (word(0, 4) !== 'RIFF' || word(8, 4) !== 'WAVE') throw new Error('not wav')
  let format = 1
  let channels = 1
  let rate = 44100
  let bits = 16
  let dataOffset = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const id = word(offset, 4)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ' && start + 16 <= buffer.byteLength) {
      format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      rate = view.getUint32(start + 4, true)
      bits = view.getUint16(start + 14, true)
    } else if (id === 'data') {
      dataOffset = start
      dataBytes = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  const width = format === 3 ? 4 : bits === 24 ? 3 : bits === 16 ? 2 : 0
  if (!width || !channels || dataOffset <= 0) throw new Error(`wav fmt ${format}/${bits}`)
  const available = Math.max(0, buffer.byteLength - dataOffset)
  const frames = Math.floor(Math.min(available, dataBytes || available) / (channels * width))
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames))
  let pointer = dataOffset
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      if (pointer + width > buffer.byteLength) break
      if (format === 3) out[channel][frame] = view.getFloat32(pointer, true)
      else if (bits === 24) {
        const code = view.getUint8(pointer) | (view.getUint8(pointer + 1) << 8) | (view.getUint8(pointer + 2) << 16)
        const signed = code & 0x800000 ? code - 0x1000000 : code
        out[channel][frame] = signed < 0 ? signed / 0x800000 : signed / 0x7fffff
      } else {
        const sample = view.getInt16(pointer, true)
        out[channel][frame] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
      }
      pointer += width
    }
  }
  return { sampleRate: rate, channels: out }
}

function ffmpegMono(path: string, seconds = 0) {
  return new Promise<{ sampleRate: number; channels: Float32Array[] }>((done, reject) => {
    const sampleRate = 44100
    const args = ['-v', 'error']
    if (seconds > 0) args.push('-t', String(seconds))
    args.push('-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1')
    const child = spawn('ffmpeg', args)
    const chunks: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `ffmpeg ${code}`))
        return
      }
      const bytes = Buffer.concat(chunks)
      const copy = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(copy).set(bytes)
      done({ sampleRate, channels: [new Float32Array(copy)] })
    })
  })
}

async function fetchCapped(url: string, maxBytes: number) {
  const response = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } })
  if (!response.ok && response.status !== 206) throw new Error(`${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function readingRow(reading: KeyReading) {
  const heard = heardFrom(reading)
  return {
    detected: heard?.label ?? '',
    clear: reading.clear,
    confidence: round3(reading.confidence),
    tonal: round3(reading.tonal),
    cents: reading.cents,
    bestCorr: round3(reading.best?.corr ?? 0),
    bestScore: round3(reading.best?.score ?? 0),
    alt: reading.alt?.name ?? '',
    altCorr: round3(reading.alt?.corr ?? 0),
  }
}

/**
 * When the tag and the detector disagree, use only the reading Detect already
 * returns. A confident call whose runner-up is not the tag is treated as
 * evidence against the tag. A low-confidence call leaves the tag in place.
 */
function judgeTag(relation: Relation, reading: KeyReading, tag: Scored) {
  if (relation === 'exact') return 'agree'
  if (!reading.clear || reading.confidence < 0.45 || reading.tonal < 0.007) return 'detector-uncertain'
  const alt = reading.alt
  const altSame = Boolean(alt && alt.root === tag.root && (alt.minor ? 'minor' : 'major') === tag.mode)
  if (altSame) return 'ambiguous-runner-up'
  const margin = (reading.best?.corr ?? 0) - (reading.alt?.corr ?? 0)
  if (reading.confidence >= 0.6 && margin >= 0.08 && reading.tonal >= 0.01 && (reading.best?.score ?? 0) >= 0.55) return 'suspected-bad-source'
  return 'disagree-inconclusive'
}

interface LibraryCandidate {
  catalog: 'instrument-library' | 'soundscout'
  id: string
  path: string
  name: string
  category: string
  instrument: string
  role: string
  pack: string
  keySource: string
  durationSec: number
  url: string
  resolved: MusicalKey
  origin: 'catalog' | 'tag' | 'filename'
}

function tagOrigin(musicalKey: string, tags: string[], path: string, name: string): 'catalog' | 'tag' | 'filename' {
  if (parseMusicalKey(musicalKey)) return 'catalog'
  if (tags.some((tag) => keyFromText(tag))) return 'tag'
  if (keyFromFilename(path) || keyFromText(name)) return 'filename'
  return 'filename'
}

async function libraryCandidates(): Promise<{ rows: LibraryCandidate[]; untagged: { instrument: number; soundscout: number } }> {
  const instrument = JSON.parse(await readFile('/tmp/key-benchmark/instrument-catalog.json', 'utf8')) as { loops?: Record<string, unknown>[] }
  const soundText = await readFile(resolve(root, 'catalogs/soundscout-2026-11-17-4.json'), 'utf8')
  const sound = JSON.parse(soundText) as { entries?: Record<string, unknown>[] }
  const rows: LibraryCandidate[] = []
  let instrumentUntagged = 0
  for (const raw of instrument.loops ?? []) {
    if (String(raw.type ?? 'loop') !== 'loop') continue
    const path = String(raw.path ?? '')
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []
    const name = String(raw.name ?? path)
    const musicalKey = typeof raw.key === 'string' ? raw.key : ''
    const pack = String(raw.packId ?? raw.pack ?? '')
    const resolved = resolveEntryKey({ key: path, name, type: 'loop', musicalKey, pack, tags })
    if (!resolved) {
      instrumentUntagged += 1
      continue
    }
    rows.push({
      catalog: 'instrument-library',
      id: String(raw.id ?? path),
      path,
      name,
      category: String(raw.category ?? ''),
      instrument: String(raw.instrument ?? ''),
      role: String(raw.role ?? ''),
      pack,
      keySource: String(raw.keySource ?? ''),
      durationSec: typeof raw.durationSec === 'number' ? raw.durationSec : 0,
      url: instrumentFileUrl(path),
      resolved,
      origin: tagOrigin(musicalKey, tags, path, name),
    })
  }
  let soundUntagged = 0
  for (const raw of sound.entries ?? []) {
    if (raw.type !== 'loop') continue
    const path = String(raw.path ?? '')
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []
    const name = String(raw.name ?? path)
    const musicalKey = typeof raw.key === 'string' ? raw.key : ''
    const pack = String(raw.pack ?? '')
    const resolved = resolveEntryKey({ key: path, name, type: 'loop', musicalKey, pack, tags })
    if (!resolved) {
      soundUntagged += 1
      continue
    }
    rows.push({
      catalog: 'soundscout',
      id: String(raw.id ?? path),
      path,
      name,
      category: String(raw.category ?? ''),
      instrument: String(raw.instrument ?? raw.category ?? ''),
      role: String(raw.role ?? ''),
      pack,
      keySource: 'catalog-field',
      durationSec: typeof raw.durationSec === 'number' ? raw.durationSec : 0,
      url: soundFileUrl(path),
      resolved,
      origin: tagOrigin(musicalKey, tags, path, name),
    })
  }
  return { rows, untagged: { instrument: instrumentUntagged, soundscout: soundUntagged } }
}

async function analyzeLibrary(items: LibraryCandidate[]) {
  const results: Record<string, unknown>[] = []
  let done = 0
  await pool(items, 6, async (item) => {
    const tag = scored(item.resolved.root, item.resolved.mode)
    const base = {
      catalog: item.catalog,
      id: item.id,
      path: item.path,
      name: item.name,
      category: item.category,
      instrument: item.instrument,
      role: item.role,
      pack: item.pack,
      keySource: item.keySource,
      origin: item.origin,
      durationSec: round3(item.durationSec),
      length: item.durationSec > 0 && item.durationSec < 8 ? 'short' : 'long',
      tag: tag.label,
    }
    try {
      const bytes = await fetchCapped(item.url, 20 * 1024 * 1024)
      let decoded: { sampleRate: number; channels: Float32Array[] }
      try {
        decoded = decodeWavWindow(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      } catch {
        const file = resolve(cacheDir, `${item.id.replace(/[^\w.-]+/g, '_')}.bin`)
        await writeFile(file, bytes)
        decoded = await ffmpegMono(file)
      }
      const mono = monoMix(decoded.channels)
      const reading = detectKey(mono, decoded.sampleRate)
      const heard = heardFrom(reading)
      const score = verdict(tag, heard)
      const judgment = judgeTag(score.relation, reading, tag)
      results.push({ ...base, ...readingRow(reading), relation: score.relation, mirex: score.mirex, semitones: score.semitones ?? '', judgment, bytes: bytes.byteLength })
    } catch (error) {
      results.push({ ...base, detected: '', clear: false, confidence: 0, relation: 'error', mirex: 0, judgment: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    done += 1
    if (done % 20 === 0 || done === items.length) console.error(`library ${done}/${items.length}`)
  })
  return results
}

function addPartial(buffer: Float32Array, start: number, seconds: number, freq: number, amp: number, decay: number, partials: number[], attack = 0.005, inharm = 0) {
  const end = Math.min(buffer.length, start + Math.floor(seconds * SR))
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR
    const env = Math.min(1, t / attack) * Math.exp(-t / decay)
    let sample = 0
    for (let p = 0; p < partials.length; p++) {
      const harm = p + 1
      const stretch = 1 + inharm * harm * harm
      sample += partials[p] * Math.sin(2 * Math.PI * freq * harm * stretch * t)
    }
    buffer[i] += amp * env * sample
  }
}

function addKarplus(buffer: Float32Array, start: number, seconds: number, freq: number, amp: number) {
  const period = Math.max(2, Math.round(SR / freq))
  const delay = new Float32Array(period)
  let seed = (Math.imul(Math.floor(freq) ^ start, 1664525) + 1013904223) >>> 0
  for (let i = 0; i < period; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    delay[i] = (seed / 4294967296) * 2 - 1
  }
  const end = Math.min(buffer.length, start + Math.floor(seconds * SR))
  let index = 0
  for (let i = start; i < end; i++) {
    const mixed = 0.996 * 0.5 * (delay[index] + delay[(index + 1) % period])
    delay[index] = mixed
    buffer[i] += amp * mixed
    index = (index + 1) % period
  }
}

function addKick(buffer: Float32Array, start: number) {
  const end = Math.min(buffer.length, start + Math.floor(0.22 * SR))
  let phase = 0
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR
    const freq = 48 + 90 * Math.exp(-t * 32)
    phase += (2 * Math.PI * freq) / SR
    buffer[i] += 0.7 * Math.exp(-t * 16) * Math.sin(phase)
  }
}

function addNoise(buffer: Float32Array, start: number, seconds: number, amp: number, decay: number, tone: number) {
  const end = Math.min(buffer.length, start + Math.floor(seconds * SR))
  let seed = (start * 9781 + 1) >>> 0
  let prev = 0
  for (let i = start; i < end; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = (seed / 4294967296) * 2 - 1
    const hat = white - prev
    prev = white
    const t = (i - start) / SR
    buffer[i] += amp * Math.exp(-t / decay) * (hat + tone * Math.sin(2 * Math.PI * 180 * t))
  }
}

function normalize(buffer: Float32Array) {
  let peak = 0
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]))
  if (peak < 1e-4) throw new Error('render was silent')
  const gain = 0.8 / peak
  for (let i = 0; i < buffer.length; i++) buffer[i] *= gain
}

type Texture = 'piano' | 'guitar' | 'pad' | 'lead' | 'full'

export function renderLoop(options: { root: number; mode: Mode; bpm: number; bars: number; texture: Texture; drums: boolean }) {
  const beat = 60 / options.bpm
  const frames = Math.round(options.bars * 4 * beat * SR)
  const buffer = new Float32Array(frames)
  const chords = options.mode === 'major'
    ? [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]]
    : [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]]
  const hz = (semi: number, octave: number) => 440 * 2 ** ((octave * 12 + options.root + semi - 69) / 12)
  for (let bar = 0; bar < options.bars; bar++) {
    const chord = chords[bar % 4]
    for (let step = 0; step < 4; step++) {
      const at = Math.round((bar * 4 + step) * beat * SR)
      if (options.drums) {
        if (step % 2 === 0) addKick(buffer, at)
        else addNoise(buffer, at, 0.18, 0.28, 0.06, 0.15)
        addNoise(buffer, at, 0.04, 0.08, 0.02, 0)
        addNoise(buffer, at + Math.round(beat * 0.5 * SR), 0.03, 0.06, 0.015, 0)
      }
      const bassSemi = step % 2 === 0 ? chord[0] : chord[2]
      addPartial(buffer, at, beat * 0.92, hz(bassSemi, 2), 0.55, 0.35, [1, 0.35, 0.12], 0.004)
      const piano = options.texture === 'piano' || options.texture === 'full'
      const guitar = options.texture === 'guitar' || options.texture === 'full'
      const pad = options.texture === 'pad' || options.texture === 'full'
      const lead = options.texture === 'lead' || options.texture === 'full'
      const mix = options.texture === 'full' ? 0.55 : 1
      if (piano && step % 2 === 0) {
        for (const semi of chord) addPartial(buffer, at, beat * 1.7, hz(semi, 4), 0.28 * mix, 0.45, [1, 0.45, 0.22, 0.12, 0.06], 0.004, 0.00015)
      }
      if (guitar) addKarplus(buffer, at, beat * 0.95, hz(chord[step % 3], 3), 0.34 * mix)
      if (pad && step === 0) {
        for (const semi of chord) addPartial(buffer, at, beat * 4.05, hz(semi, 4), 0.16 * mix, 2.4, [1, 0.2, 0.08], 0.12)
      }
      if (lead) {
        const degrees = [chord[0], chord[1], chord[2], chord[0] + 12]
        addPartial(buffer, at, beat * 0.8, hz(degrees[step], 5), 0.22 * mix, 0.28, [1, 0.4, 0.18, 0.08], 0.01)
      }
    }
  }
  normalize(buffer)
  return buffer
}

function analyzeBuffer(buffer: Float32Array, truth: Scored) {
  const reading = detectKey(buffer, SR)
  const heard = heardFrom(reading)
  const score = verdict(truth, heard)
  return { reading, score, heard }
}

function renderSuite() {
  const rows: Record<string, unknown>[] = []
  const kept: { id: string; buffer: Float32Array; truth: Scored; texture: Texture; drums: boolean; bars: number; bpm: number }[] = []
  const textures: Texture[] = ['piano', 'guitar', 'pad', 'lead', 'full']
  let n = 0
  for (const mode of ['major', 'minor'] as const) {
    for (let root = 0; root < 12; root++) {
      for (const bpm of [90, 140]) {
        for (const bars of [4, 8]) {
          for (const texture of textures) {
            for (const drums of [false, true]) {
              const truth = scored(root, mode)
              const buffer = renderLoop({ root, mode, bpm, bars, texture, drums })
              const { reading, score } = analyzeBuffer(buffer, truth)
              const id = `${truth.label.replace(' ', '-')}-${texture}-${drums ? 'drums' : 'nodrums'}-${bpm}-${bars}bar`
              rows.push({
                id,
                texture,
                drums: drums ? 'yes' : 'no',
                bars,
                length: bars <= 4 ? 'short' : 'long',
                bpm,
                seconds: round3(buffer.length / SR),
                truth: truth.label,
                ...readingRow(reading),
                relation: score.relation,
                mirex: score.mirex,
              })
              if ((texture === 'piano' && !drums && bars === 8 && bpm === 90 && (root === 0 || (root === 9 && mode === 'minor'))) || (texture === 'full' && drums && bars === 8 && bpm === 140 && root === 0 && mode === 'major')) {
                kept.push({ id, buffer, truth, texture, drums, bars, bpm })
              }
              n += 1
              if (n % 100 === 0) console.error(`render ${n}`)
            }
          }
        }
      }
    }
  }
  return { rows, kept }
}

function shiftSuite(sources: { id: string; buffer: Float32Array; truth: Scored }[]) {
  const rows: Record<string, unknown>[] = []
  for (const source of sources) {
    for (let semitones = 0; semitones < 12; semitones++) {
      const shifted = formantPitchChannels([source.buffer], SR, { semitones, formant: true })[0]
      const truth = scored(source.truth.root + semitones, source.truth.mode)
      const reading = detectKey(shifted, SR)
      const heard = heardFrom(reading)
      const score = verdict(truth, heard)
      rows.push({
        source: source.id,
        semitones,
        formant: 'yes',
        from: source.truth.label,
        truth: truth.label,
        ...readingRow(reading),
        relation: score.relation,
        mirex: score.mirex,
      })
      console.error(`shift ${source.id} +${semitones} ${heard?.label ?? 'none'}`)
    }
  }
  return rows
}

function mapGiantLabel(raw: string): { truth: Scored | null; reason: string; strict: boolean } {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text || text.includes('|')) return { truth: null, reason: 'multi-or-empty', strict: false }
  const match = text.match(/^([A-Ga-g][#b♯♭]?)\s+(.+)$/)
  if (!match) return { truth: null, reason: 'unparsed', strict: false }
  const rest = match[2].toLowerCase().replace('phryrgian', 'phrygian')
  if (/\bother\b/.test(rest)) return { truth: null, reason: 'other', strict: false }
  let mode: Mode | null = null
  if (/(major|ionian|lydian|mixolydian)/.test(rest)) mode = 'major'
  else if (/(minor|aeolian|dorian|phrygian|locrian|harmonic|melodic)/.test(rest)) mode = 'minor'
  if (!mode) return { truth: null, reason: 'unparsed', strict: false }
  const parsed = parseMusicalKey(`${match[1]} ${mode}`)
  if (!parsed) return { truth: null, reason: 'unparsed', strict: false }
  const strict = /^(major|minor)$/.test(rest)
  return { truth: scored(parsed.root, parsed.mode), reason: strict ? 'strict' : 'modal-mapped', strict }
}

async function analyzeGiantsteps() {
  const audioRoot = '/tmp/key-benchmark/audio'
  const keyRoot = '/tmp/key-benchmark/keys/keys_gs+'
  const { readdir } = await import('node:fs/promises')
  const audioNames = (await readdir(audioRoot)).filter((name) => !name.startsWith('.') && !name.startsWith('._') && name.endsWith('.mp3'))
  const keyNames = (await readdir(keyRoot)).filter((name) => name.endsWith('.txt'))
  const audioById = new Map<string, string>()
  for (const name of audioNames) {
    const id = name.match(/(\d{4,})/)?.[1]
    if (id) audioById.set(id, resolve(audioRoot, name))
  }
  const rows: Record<string, unknown>[] = []
  const manifest: string[] = []
  let index = 0
  for (const name of keyNames) {
    const id = name.match(/(\d{4,})/)?.[1] ?? name
    const audio = audioById.get(id)
    const raw = (await readFile(resolve(keyRoot, name), 'utf8')).replace(/\0/g, '').trim()
    const mapped = mapGiantLabel(raw)
    index += 1
    if (!audio || !mapped.truth) {
      rows.push({
        id,
        file: name,
        label: raw,
        reason: audio ? mapped.reason : 'missing-audio',
        strict: mapped.strict ? 'yes' : 'no',
        truth: mapped.truth?.label ?? '',
        detected: '',
        clear: false,
        confidence: 0,
        relation: 'excluded',
        mirex: 0,
      })
      continue
    }
    try {
      const decoded = await ffmpegMono(audio)
      const reading = detectKey(monoMix(decoded.channels), decoded.sampleRate)
      const heard = heardFrom(reading)
      const score = verdict(mapped.truth, heard)
      rows.push({
        id,
        file: name,
        label: raw,
        reason: mapped.reason,
        strict: mapped.strict ? 'yes' : 'no',
        truth: mapped.truth.label,
        ...readingRow(reading),
        relation: score.relation,
        mirex: score.mirex,
        tonic: heard ? (heard.root === mapped.truth.root ? 'yes' : 'no') : 'no',
      })
      manifest.push(JSON.stringify({ id, path: audio, seconds: 0, alsoFull: false }))
    } catch (error) {
      rows.push({ id, file: name, label: raw, truth: mapped.truth.label, relation: 'error', mirex: 0, clear: false, confidence: 0, error: error instanceof Error ? error.message : String(error) })
    }
    if (index % 25 === 0) console.error(`giantsteps ${index}/${keyNames.length}`)
  }
  await writeFile(resolve(outDir, 'giantsteps-manifest.jsonl'), `${manifest.join('\n')}\n`)
  return rows
}

function librarySummary(rows: Record<string, unknown>[]) {
  const scoredRows = rows.filter((row) => row.relation !== 'error') as { relation: string; mirex: number; origin: string; keySource: string; category: string; catalog: string; length: string; confidence: number; clear: boolean; judgment: string; id: string; tag: string; detected: string; name: string; path: string }[]
  const errors = scoredRows.filter((row) => row.relation === 'error')
  void errors
  return {
    scored: tally(scoredRows),
    byCatalog: groupBy(scoredRows, (row) => String(row.catalog)),
    byOrigin: groupBy(scoredRows, (row) => String(row.origin)),
    byKeySource: groupBy(scoredRows, (row) => String(row.keySource || '(blank)')),
    byCategory: groupBy(scoredRows, (row) => String(row.category || '(blank)')),
    byLength: groupBy(scoredRows, (row) => String(row.length)),
    calibration: calibration(scoredRows.map((row) => ({ clear: Boolean(row.clear), confidence: Number(row.confidence), relation: String(row.relation), mirex: Number(row.mirex) }))),
    judgments: groupBy(scoredRows, (row) => String(row.judgment)),
    suspectedBadSource: scoredRows
      .filter((row) => row.judgment === 'suspected-bad-source')
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))
      .slice(0, 40)
      .map((row) => ({ id: row.id, name: row.name, path: row.path, keySource: row.keySource, tag: row.tag, detected: row.detected, confidence: row.confidence, relation: row.relation })),
    errors: rows.filter((row) => row.relation === 'error').length,
  }
}

async function main() {
  selfCheck()
  await mkdir(outDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  console.error('collecting keyed loops')
  const { rows: candidates, untagged } = await libraryCandidates()
  console.error(`keyed ${candidates.length} untagged instrument ${untagged.instrument} soundscout ${untagged.soundscout}`)
  const library = await analyzeLibrary(candidates)
  await writeCsv(resolve(outDir, 'library-comparison.csv'), library)
  console.error('rendering ground-truth loops')
  const rendered = renderSuite()
  await writeCsv(resolve(outDir, 'rendered-benchmark.csv'), rendered.rows)
  console.error('shifting known loops')
  const shifted = shiftSuite(rendered.kept)
  await writeCsv(resolve(outDir, 'shifter-benchmark.csv'), shifted)
  let giant: Record<string, unknown>[] = []
  try {
    console.error('scoring GiantSteps+')
    giant = await analyzeGiantsteps()
    await writeCsv(resolve(outDir, 'giantsteps-benchmark.csv'), giant)
  } catch (error) {
    console.error(`giantsteps skipped: ${error instanceof Error ? error.message : error}`)
  }
  const giantScored = giant.filter((row) => row.relation !== 'excluded' && row.relation !== 'error') as { relation: string; mirex: number; strict: string; confidence: number; clear: boolean; tonic: string }[]
  const summary = {
    privateCatalog: 'Not read. The passphrase-protected library was not opened and was not tagged.',
    detector: 'Rebuilt detectKey: full buffer, loop wrap under 32s, HPSS, whitened log-frequency chroma, blend profiles by default.',
    library: {
      untaggedNotAnalyzed: untagged,
      keyed: candidates.length,
      ...librarySummary(library),
    },
    rendered: {
      ...tally(rendered.rows as { relation: string; mirex: number }[]),
      byTexture: groupBy(rendered.rows as { relation: string; mirex: number; texture: string }[], (row) => String(row.texture)),
      byDrums: groupBy(rendered.rows as { relation: string; mirex: number; drums: string }[], (row) => String(row.drums)),
      byLength: groupBy(rendered.rows as { relation: string; mirex: number; length: string }[], (row) => String(row.length)),
      byTempo: groupBy(rendered.rows as { relation: string; mirex: number; bpm: number }[], (row) => String(row.bpm)),
      byMode: groupBy(rendered.rows as { relation: string; mirex: number; truth: string }[], (row) => String(row.truth).endsWith('minor') ? 'minor' : 'major'),
      calibration: calibration(rendered.rows as { clear: boolean; confidence: number; relation: string; mirex: number }[]),
    },
    shifter: {
      ...tally(shifted as { relation: string; mirex: number }[]),
      bySource: groupBy(shifted as { relation: string; mirex: number; source: string }[], (row) => String(row.source)),
    },
    giantsteps: giant.length
      ? {
          files: giant.length,
          excluded: giant.filter((row) => row.relation === 'excluded').length,
          errors: giant.filter((row) => row.relation === 'error').length,
          scored: tally(giantScored),
          strict: tally(giantScored.filter((row) => row.strict === 'yes')),
          modalMapped: tally(giantScored.filter((row) => row.strict !== 'yes')),
          tonicRate: round3(mean(giantScored.map((row) => (row.tonic === 'yes' ? 1 : 0)))),
          calibration: calibration(giantScored),
        }
      : { skipped: true },
  }
  await writeFile(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  mkdir(outDir, { recursive: true }).then(() => {
    const log = createWriteStream(resolve(outDir, 'run.log'), { flags: 'a' })
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error) => void) => {
      log.write(chunk)
      return write(chunk, encoding, cb)
    }) as typeof process.stderr.write
    return main()
  }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
