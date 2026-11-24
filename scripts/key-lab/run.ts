/**
 * Key-detection lab.
 *
 * Reads public annotations and local audio, renders synthetic loops, and
 * samples filename-labeled library loops. It does not write catalog keys,
 * tag the library, or upload audio.
 *
 *   node --experimental-strip-types scripts/key-lab/run.ts
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { keyFromFilename, keyFromText, parseMusicalKey } from '../../src/library/musicalKey.ts'
import { extract } from './engine.ts'
import {
  applyBass,
  applyVote,
  learnProfile,
  rankNamed,
  relativeOf,
  sameKey,
  selfCheckScores,
  tally,
  verdict,
  type Guess,
  type ProfileId,
  type Relation,
  type Tally,
  type Truth,
  PROFILE_IDS,
} from './evaluate.ts'
import { predictCnn, predictMlp, trainCnn, trainMlp, type Example } from './models.ts'
import { SYNTH_RATE, renderSuite } from './synth.ts'
import { analysePcm, type Analysis } from './worker.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lab = '/tmp/key-lab'
const cacheDir = `${lab}/cache/v1`
const outDir = '/opt/cursor/artifacts/key-lab'
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

interface Shipped {
  clear: boolean
  root: number | null
  scale: string
  confidence: number
  label: string
  bestRoot: number | null
  bestMinor: boolean
  bestCorr: number
  tonal: number
}

interface Item {
  id: string
  dataset: 'giantsteps+' | 'beatport' | 'mtg' | 'synthetic' | 'library'
  content: 'loop' | 'one-shot' | 'track' | 'drum' | 'noise'
  texture: string
  family: string
  seconds: number
  truth: Truth | null
  fold: number
  analysis: Analysis
}

function foldOf(id: string) {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return Math.abs(hash) % 5
}

function labelOf(key: Truth) {
  return `${NAMES[key.root]} ${key.mode}`
}

function mapLabel(raw: string): Truth | null {
  const text = raw.replace(/\0/g, '').replace(/\s+/g, ' ').trim()
  if (!text || text === 'X' || text === '-' || text.includes('|')) return null
  const match = text.match(/^([A-Ga-g][#b♯♭]?)\s+(.+)$/)
  if (!match) return null
  const rest = match[2].toLowerCase().replace('phryrgian', 'phrygian')
  if (/\bother\b/.test(rest)) return null
  let mode: 'major' | 'minor' | null = null
  if (/(major|ionian|lydian|mixolydian)/.test(rest)) mode = 'major'
  else if (/(minor|aeolian|dorian|phrygian|locrian|harmonic|melodic)/.test(rest)) mode = 'minor'
  if (!mode) return null
  const parsed = parseMusicalKey(`${match[1]} ${mode}`)
  if (!parsed) return null
  return { root: parsed.root, mode: parsed.mode }
}

async function readKeyDir(dir: string) {
  const map = new Map<string, string>()
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return map
  }
  for (const name of names) {
    if (!name.endsWith('.txt') || name.startsWith('._')) continue
    const id = name.match(/(\d{3,})/)?.[1]
    if (!id) continue
    const text = await readFile(resolve(dir, name), 'utf8')
    map.set(id, text.trim())
  }
  return map
}

async function audioMap(dir: string) {
  const map = new Map<string, string>()
  const walk = async (current: string) => {
    let names: string[] = []
    try {
      names = await readdir(current)
    } catch {
      return
    }
    for (const name of names) {
      const path = resolve(current, name)
      if (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.flac')) {
        const id = name.match(/(\d{3,})/)?.[1]
        if (id && !name.startsWith('._')) map.set(id, path)
      } else if (!name.includes('.')) {
        await walk(path)
      }
    }
  }
  await walk(dir)
  return map
}

function unzip(zip: string, dest: string) {
  return new Promise<void>((done, reject) => {
    const child = spawn('unzip', ['-qo', zip, '-d', dest])
    child.on('close', (code) => (code === 0 ? done() : reject(new Error(`unzip ${code}`))))
  })
}

async function selfCheck() {
  selfCheckScores()
  const sine = new Float32Array(SYNTH_RATE * 2)
  for (let i = 0; i < sine.length; i++) sine[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SYNTH_RATE)
  const tuned = extract(sine, SYNTH_RATE)
  let bin = 0
  let peak = -1
  tuned.full.hpcp440.forEach((value, index) => {
    if (value > peak) {
      peak = value
      bin = index
    }
  })
  if (bin !== 0) throw new Error(`A440 HPCP peaked at bin ${bin}, expected 0 (A)`)
  const suite = renderSuite()
  const major = suite.find((row) => row.id === 'cadence-major-0')
  const minor = suite.find((row) => row.id === 'cadence-minor-9')
  if (!major || !minor) throw new Error('missing self-check renders')
  const majorRank = rankNamed(extract(major.samples, SYNTH_RATE).full.hpcpTuned, 'edma-essentia')[0]
  const minorRank = rankNamed(extract(minor.samples, SYNTH_RATE).full.hpcpTuned, 'edma-essentia')[0]
  if (majorRank.root !== 0 || majorRank.mode !== 'major') {
    throw new Error(`C major cadence heard as ${labelOf(majorRank)} corr ${majorRank.corr.toFixed(3)}`)
  }
  if (minorRank.root !== 9 || minorRank.mode !== 'minor') {
    throw new Error(`A minor cadence heard as ${labelOf(minorRank)} corr ${minorRank.corr.toFixed(3)}`)
  }
  console.error('self-check ok')
  return suite
}

function shippedGuess(pack: Shipped, open: boolean): Guess | null {
  if (!open) {
    if (!pack.clear || pack.root == null || (pack.scale !== 'ionian' && pack.scale !== 'aeolian')) return null
    return { root: pack.root, mode: pack.scale === 'aeolian' ? 'minor' : 'major', corr: pack.bestCorr, runner: 0, confidence: pack.confidence }
  }
  if (pack.bestRoot == null) return null
  return { root: pack.bestRoot, mode: pack.bestMinor ? 'minor' : 'major', corr: pack.bestCorr, runner: 0, confidence: pack.confidence }
}

function viewOf(item: Item, window: 'live' | 'full') {
  return window === 'live' ? item.analysis.live : item.analysis.full
}

function guessProfile(item: Item, window: 'live' | 'full', profile: ProfileId, learned?: { major: number[]; minor: number[] }) {
  const view = viewOf(item, window)
  const ranked = rankNamed(view.hpcpTuned, profile, learned)
  const best = ranked[0]
  const runner = ranked[1]
  const margin = (best?.corr ?? 0) - (runner?.corr ?? 0)
  let confidence = Math.max(0, Math.min(1, 0.55 * Math.max(0, Math.min(1, ((best?.corr ?? 0) - 0.15) / 0.55)) + 0.45 * Math.max(0, Math.min(1, margin / 0.12))))
  if (view.entropy > 0.995) confidence *= 0.45
  return {
    root: best.root,
    mode: best.mode,
    corr: best.corr,
    runner: runner?.corr ?? 0,
    confidence,
  } satisfies Guess
}

function guessFront(item: Item, window: 'live' | 'full', field: 'hpcp440' | 'hpcpTuned' | 'hpcpNoHarm' | 'hpcpRaw' | 'nnls') {
  const view = viewOf(item, window)
  const ranked = rankNamed(view[field], 'edma-essentia')
  return guessProfile({ ...item, analysis: { ...item.analysis, [window]: { ...view, hpcpTuned: view[field] } } }, window, 'edma-essentia')
}

type LearnedPack = {
  synth?: { major: number[]; minor: number[] }
  folds: { major: number[]; minor: number[] }[]
  allGs?: { major: number[]; minor: number[] }
}

function learnedFor(item: Item, pack: LearnedPack) {
  if (item.dataset === 'giantsteps+' && pack.folds[item.fold]) return pack.folds[item.fold]
  if (item.dataset === 'synthetic') return pack.allGs
  return pack.allGs
}

function guessOf(item: Item, method: string, window: 'live' | 'full', learned: LearnedPack, extras: Map<string, Guess | null>) {
  const view = viewOf(item, window)
  const shipped = window === 'live' ? item.analysis.shippedLive : item.analysis.shippedFull
  if (method === 'shipped-clear') return shippedGuess(shipped, false)
  if (method === 'shipped-open') return shippedGuess(shipped, true)
  if (method === 'hpcp-440-edma') return guessFront(item, window, 'hpcp440')
  if (method === 'hpcp-tuned-edma') return guessFront(item, window, 'hpcpTuned')
  if (method === 'hpcp-noharm-edma') return guessFront(item, window, 'hpcpNoHarm')
  if (method === 'hpcp-raw-edma') return guessFront(item, window, 'hpcpRaw')
  if (method === 'nnls-edma') return guessFront(item, window, 'nnls')
  if (method === 'profile-faraldo') return guessProfile(item, window, 'faraldo')
  if (method === 'profile-temperley') return guessProfile(item, window, 'temperley')
  if (method === 'profile-krumhansl') return guessProfile(item, window, 'krumhansl')
  if (method === 'profile-shaath') return guessProfile(item, window, 'shaath')
  if (method === 'profile-blend') return guessProfile(item, window, 'blend')
  if (method === 'bass-cadence') return applyBass(rankNamed(view.hpcpTuned, 'edma-essentia'), view.bass, view.segments, view.entropy)
  if (method === 'segment-vote') return applyVote(view.hpcpTuned, view.segments, view.entropy)
  if (method === 'combined') {
    const voted = applyVote(view.hpcpTuned, view.segments, view.entropy)
    const ranked = rankNamed(view.hpcpTuned, 'edma-essentia')
    const top = ranked.find((row) => row.root === voted.root && row.mode === voted.mode) ?? ranked[0]
    const rest = ranked.filter((row) => row !== top)
    return applyBass([top, ...rest], view.bass, view.segments, view.entropy)
  }
  if (method === 'learned-synth' && learned.synth) return guessProfile(item, window, 'learned', learned.synth)
  if (method === 'learned-gs') {
    const profile = learnedFor(item, learned)
    if (!profile) return null
    return guessProfile(item, window, 'learned', profile)
  }
  return extras.get(`${item.id}|${window}|${method}`)
}

const METHODS = [
  'shipped-clear',
  'shipped-open',
  'hpcp-440-edma',
  'hpcp-tuned-edma',
  'hpcp-noharm-edma',
  'hpcp-raw-edma',
  'nnls-edma',
  'profile-faraldo',
  'profile-temperley',
  'profile-krumhansl',
  'profile-shaath',
  'profile-blend',
  'bass-cadence',
  'segment-vote',
  'combined',
  'learned-synth',
  'learned-gs',
  'mlp-cv',
  'cnn-split',
  'mlp-synth',
  'cnn-synth',
]

function heardTruth(guess: Guess | null): Truth | null {
  if (!guess) return null
  return { root: guess.root, mode: guess.mode }
}

function asGuessMap(items: Item[], guesses: (Guess | null | undefined)[]) {
  const map = new Map<string, Guess | null | undefined>()
  items.forEach((item, index) => map.set(item.id, guesses[index]))
  return map
}

function scoreRows(subset: Item[], guesses: Map<string, Guess | null | undefined>) {
  const rows: { relation: Relation; mirex: number }[] = []
  for (const item of subset) {
    if (!item.truth) continue
    const guess = guesses.get(item.id)
    if (guess === undefined) continue
    rows.push(verdict(item.truth, heardTruth(guess)))
  }
  return tally(rows)
}

function groupScore(subset: Item[], guesses: Map<string, Guess | null | undefined>, key: (item: Item) => string) {
  const buckets = new Map<string, { item: Item; guess: Guess | null }[]>()
  for (const item of subset) {
    if (!item.truth) continue
    const guess = guesses.get(item.id)
    if (guess === undefined) continue
    const name = key(item)
    const list = buckets.get(name) ?? []
    list.push({ item, guess })
    buckets.set(name, list)
  }
  const out: Record<string, Tally> = {}
  for (const [name, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[name] = tally(list.map((row) => verdict(row.item.truth, heardTruth(row.guess))))
  }
  return out
}

function refusal(subset: Item[], guesses: Map<string, Guess | null | undefined>, content: string) {
  const slice = subset.filter((item) => item.content === content && guesses.get(item.id) !== undefined)
  const named = slice.filter((item) => guesses.get(item.id)).length
  return { n: slice.length, named, refused: slice.length - named }
}

function exampleOf(item: Item, window: 'live' | 'full'): Example {
  const view = viewOf(item, window)
  return {
    chroma: view.hpcpTuned,
    bass: view.bass,
    start: view.segments[0] ?? view.hpcpTuned,
    end: view.segments[3] ?? view.hpcpTuned,
    cqt: window === 'live' ? item.analysis.cqtLive : item.analysis.cqtFull,
    truth: item.truth ?? { root: 0, mode: 'major' },
  }
}

function predictToGuess(pred: { root: number; mode: 'major' | 'minor'; probability: number }): Guess {
  return { root: pred.root, mode: pred.mode, corr: pred.probability, runner: 0, confidence: pred.probability }
}

async function cacheRead(id: string): Promise<Analysis | null> {
  try {
    return JSON.parse(await readFile(resolve(cacheDir, `${id.replace(/[^\w.-]+/g, '_')}.json`), 'utf8')) as Analysis
  } catch {
    return null
  }
}

async function cacheWrite(id: string, analysis: Analysis) {
  await writeFile(resolve(cacheDir, `${id.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(analysis))
}

async function runPool(jobs: { id: string; path: string }[]) {
  const pending = []
  for (const job of jobs) {
    const cached = await cacheRead(job.id)
    if (!cached) pending.push(job)
  }
  console.error(`files ${jobs.length}, cached ${jobs.length - pending.length}, to run ${pending.length}`)
  const out = new Map<string, Analysis>()
  for (const job of jobs) {
    const cached = await cacheRead(job.id)
    if (cached) out.set(job.id, cached)
  }
  if (!pending.length) return out
  const width = Math.min(3, pending.length)
  const workers = Array.from({ length: width }, () => new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] }))
  let cursor = 0
  let done = jobs.length - pending.length
  async function loop(worker: Worker) {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const job = pending[index]
      try {
        const result = await new Promise<Analysis>((resolveJob, reject) => {
          const onMessage = (data: { ok: boolean; result?: Analysis; error?: string }) => {
            worker.off('message', onMessage)
            if (!data.ok || !data.result) reject(new Error(data.error || 'worker failed'))
            else resolveJob(data.result)
          }
          worker.on('message', onMessage)
          worker.postMessage({ id: index, path: job.path, sampleRate: 44100 })
        })
        out.set(job.id, result)
        await cacheWrite(job.id, result)
      } catch (error) {
        console.error(`failed ${job.id}: ${error instanceof Error ? error.message : error}`)
      }
      done += 1
      if (done % 25 === 0 || done === jobs.length) console.error(`analysed ${done}/${jobs.length}`)
    }
  }
  await Promise.all(workers.map((worker) => loop(worker)))
  await Promise.all(workers.map((worker) => worker.terminate()))
  return out
}

function fmt(tallyRow: Tally | undefined) {
  if (!tallyRow || !tallyRow.n) return '—'
  return `${tallyRow.exact}/${tallyRow.n} ${(100 * tallyRow.exactRate).toFixed(1)}% · MIREX ${tallyRow.mirex.toFixed(3)} · rel ${tallyRow.relative}`
}

function mdTable(headers: string[], rows: string[][]) {
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, rule, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

async function main() {
  await mkdir(cacheDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  const log = createWriteStream(resolve(outDir, 'run.log'), { flags: 'a' })
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error) => void) => {
    log.write(chunk)
    return write(chunk, encoding, cb)
  }) as typeof process.stderr.write
  const suite = await selfCheck()
  const items: Item[] = []
  console.error(`rendering ${suite.length} synthetic clips`)
  for (const clip of suite) {
    const analysis = analysePcm(clip.samples, SYNTH_RATE)
    const keyed = clip.content === 'drum' || clip.content === 'noise' ? null : { root: clip.root, mode: clip.mode }
    items.push({
      id: `synthetic:${clip.id}`,
      dataset: 'synthetic',
      content: clip.content,
      texture: clip.texture,
      family: clip.family,
      seconds: analysis.seconds,
      truth: keyed,
      fold: -1,
      analysis,
    })
  }
  const gsKeys = await readKeyDir(`${lab}/annotations-gsplus/keys_gs+`)
  const gsAudio = await audioMap(`${lab}/audio-gsplus`)
  const beatKeys = await readKeyDir(`${lab}/annotations-beatport/keys`)
  let beatAudio = await audioMap(`${lab}/audio-beatport`)
  if (!beatAudio.size) {
    try {
      console.error('unzipping beatport audio')
      await unzip(`${lab}/beatport-audio.zip`, `${lab}/audio-beatport`)
      beatAudio = await audioMap(`${lab}/audio-beatport`)
    } catch (error) {
      console.error(`beatport audio unavailable: ${error instanceof Error ? error.message : error}`)
    }
  }
  const mtg = new Map<string, { text: string; conf: number }>()
  try {
    const lines = (await readFile(`${lab}/mtg/annotations.txt`, 'utf8')).split('\n').slice(1)
    for (const line of lines) {
      if (!line.trim()) continue
      const [id, text, conf] = line.split('\t')
      if (id) mtg.set(id, { text: text ?? '', conf: Number(conf) || 0 })
    }
  } catch {
    console.error('mtg annotations missing')
  }
  const jobs: { id: string; path: string }[] = []
  const meta = new Map<string, Omit<Item, 'analysis'>>()
  const pushFile = (id: string, path: string, row: Omit<Item, 'analysis'>) => {
    jobs.push({ id, path })
    meta.set(id, row)
  }
  let gsExcluded = 0
  for (const [id, text] of gsKeys) {
    const path = gsAudio.get(id)
    if (!path) continue
    const truth = mapLabel(text)
    if (!truth) {
      gsExcluded += 1
      continue
    }
    const itemId = `gs:${id}`
    pushFile(itemId, path, {
      id: itemId,
      dataset: 'giantsteps+',
      content: 'track',
      texture: 'track',
      family: 'giantsteps+',
      seconds: 0,
      truth,
      fold: foldOf(id),
    })
  }
  let beatExcluded = 0
  for (const [id, text] of beatKeys) {
    const path = beatAudio.get(id)
    if (!path) continue
    const truth = mapLabel(text)
    if (!truth) {
      beatExcluded += 1
      continue
    }
    const itemId = `beatport:${id}`
    pushFile(itemId, path, {
      id: itemId,
      dataset: 'beatport',
      content: 'track',
      texture: 'track',
      family: 'beatport',
      seconds: 0,
      truth,
      fold: -1,
    })
  }
  let mtgUsed = 0
  for (const [id, row] of mtg) {
    const path = beatAudio.get(id) ?? gsAudio.get(id)
    if (!path) continue
    const truth = mapLabel(row.text)
    if (!truth) continue
    const itemId = `mtg:${id}`
    if (meta.has(itemId)) continue
    mtgUsed += 1
    pushFile(itemId, path, {
      id: itemId,
      dataset: 'mtg',
      content: 'track',
      texture: 'track',
      family: row.conf >= 2 ? 'mtg-confident' : 'mtg',
      seconds: 0,
      truth,
      fold: -1,
    })
  }
  console.error(`gs jobs ${[...meta.values()].filter((row) => row.dataset === 'giantsteps+').length} excluded ${gsExcluded}; beatport jobs ${[...meta.values()].filter((row) => row.dataset === 'beatport').length} excluded ${beatExcluded}; mtg ${mtgUsed}`)
  await addLibrary(jobs, meta)
  const byPath = new Map<string, string>()
  const unique: { id: string; path: string }[] = []
  const seenPath = new Set<string>()
  for (const job of jobs) {
    byPath.set(job.id, job.path)
    if (seenPath.has(job.path)) continue
    seenPath.add(job.path)
    unique.push(job)
  }
  const analysedByPath = await runPool(unique)
  const analysed = new Map<string, Analysis>()
  for (const [id, path] of byPath) {
    const analysis = analysedByPath.get(unique.find((job) => job.path === path)?.id ?? '')
    if (analysis) analysed.set(id, analysis)
  }
  let missing = 0
  for (const [id, row] of meta) {
    const analysis = analysed.get(id)
    if (!analysis) {
      missing += 1
      continue
    }
    const low = analysis.full.lowShare
    const texture = row.dataset === 'synthetic' ? row.texture : (low > 0.55 ? 'bass-heavy' : 'melodic')
    items.push({ ...row, seconds: analysis.seconds, texture, analysis })
  }
  console.error(`items ${items.length}, missing files ${missing}`)
  const learned = trainProfiles(items)
  const extras = trainClassifiers(items)
  const summary = buildSummary(items, learned, extras, { gsExcluded, beatExcluded, mtgAnnotations: mtg.size, mtgMatched: mtgUsed })
  await writeFile(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  await writeFile(resolve(outDir, 'report.md'), summary.report)
  console.log(summary.report)
}

async function addLibrary(jobs: { id: string; path: string }[], meta: Map<string, Omit<Item, 'analysis'>>) {
  const catalog = JSON.parse(await readFile(`${lab}/instrument-catalog.json`, 'utf8')) as { loops?: Record<string, unknown>[] }
  const loops = catalog.loops ?? []
  const picked: { id: string; path: string; name: string; seconds: number; truth: Truth }[] = []
  for (const raw of loops) {
    if (String(raw.type ?? 'loop') !== 'loop') continue
    const path = String(raw.path ?? '')
    const name = String(raw.name ?? '')
    const named = keyFromFilename(path) ?? keyFromText(name)
    if (!named) continue
    picked.push({
      id: `library:${String(raw.id ?? path)}`,
      path,
      name,
      seconds: typeof raw.durationSec === 'number' ? raw.durationSec : 0,
      truth: { root: named.root, mode: named.mode },
    })
  }
  const byKey = new Map<string, typeof picked>()
  for (const row of picked) {
    const key = `${row.truth.root}:${row.truth.mode}`
    const list = byKey.get(key) ?? []
    list.push(row)
    byKey.set(key, list)
  }
  const sample: typeof picked = []
  const shorts = picked.filter((row) => row.seconds > 0 && row.seconds < 4)
  for (const row of shorts.slice(0, 16)) sample.push(row)
  const seen = new Set(sample.map((row) => row.id))
  let guard = 0
  while (sample.length < Math.min(72, picked.length) && guard < 500) {
    guard += 1
    for (const list of byKey.values()) {
      const next = list.find((row) => !seen.has(row.id))
      if (!next) continue
      seen.add(next.id)
      sample.push(next)
      if (sample.length >= Math.min(72, picked.length)) break
    }
  }
  console.error(`library filename loops ${picked.length}, sampling ${sample.length}`)
  const dir = `${lab}/library`
  await mkdir(dir, { recursive: true })
  const base = 'https://huggingface.co/datasets/cueharbor/instrument-library/resolve/6494a1a8c8dc2914fccc8656d066ca872ef1e04a/'
  let cursor = 0
  async function pull() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= sample.length) return
      const row = sample[index]
      const file = resolve(dir, `${row.id.replace(/[^\w.-]+/g, '_')}.wav`)
      try {
        try {
          await readFile(file)
        } catch {
          const response = await fetch(base + row.path.split('/').map(encodeURIComponent).join('/'))
          if (!response.ok) throw new Error(`${response.status} ${row.path}`)
          await writeFile(file, Buffer.from(await response.arrayBuffer()))
        }
      } catch (error) {
        console.error(`library skip ${row.path}: ${error instanceof Error ? error.message : error}`)
        continue
      }
      jobs.push({ id: row.id, path: file })
      meta.set(row.id, {
        id: row.id,
        dataset: 'library',
        content: row.seconds > 0 && row.seconds < 1.5 ? 'one-shot' : 'loop',
        texture: 'filename',
        family: 'filename',
        seconds: row.seconds,
        truth: row.truth,
        fold: -1,
      })
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => pull()))
}

function trainProfiles(items: Item[]): LearnedPack {
  const synthRows = items.filter((item) => item.dataset === 'synthetic' && item.truth && item.family !== 'relative-trap')
  const synth = learnProfile(synthRows.map((item) => ({ pcp: item.analysis.full.hpcpTuned, truth: item.truth as Truth })))
  const gs = items.filter((item) => item.dataset === 'giantsteps+' && item.truth)
  const folds = []
  for (let fold = 0; fold < 5; fold++) {
    const train = gs.filter((item) => item.fold !== fold)
    folds.push(learnProfile(train.map((item) => ({ pcp: item.analysis.full.hpcpTuned, truth: item.truth as Truth }))))
  }
  const allGs = learnProfile(gs.map((item) => ({ pcp: item.analysis.full.hpcpTuned, truth: item.truth as Truth })))
  console.error(`learned profiles synth n=${synth.majorN + synth.minorN} gs n=${allGs.majorN + allGs.minorN}`)
  return { synth, folds, allGs }
}

function trainClassifiers(items: Item[]) {
  const extras = new Map<string, Guess | null>()
  const gs = items.filter((item) => item.dataset === 'giantsteps+' && item.truth)
  const synth = items.filter((item) => item.dataset === 'synthetic' && item.truth && item.content === 'loop')
  console.error('training mlp folds')
  for (let fold = 0; fold < 5; fold++) {
    const model = trainMlp(gs.filter((item) => item.fold !== fold).map((item) => exampleOf(item, 'full')))
    for (const item of gs.filter((row) => row.fold === fold)) {
      extras.set(`${item.id}|full|mlp-cv`, predictToGuess(predictMlp(model, exampleOf(item, 'full'))))
      extras.set(`${item.id}|live|mlp-cv`, predictToGuess(predictMlp(model, exampleOf(item, 'live'))))
    }
  }
  console.error('training mlp transfer models')
  const mlpGs = trainMlp(gs.map((item) => exampleOf(item, 'full')))
  const mlpSynth = trainMlp(synth.map((item) => exampleOf(item, 'full')))
  for (const item of items) {
    if (!item.truth) continue
    if (item.dataset !== 'giantsteps+') {
      extras.set(`${item.id}|full|mlp-cv`, predictToGuess(predictMlp(mlpGs, exampleOf(item, 'full'))))
      extras.set(`${item.id}|live|mlp-cv`, predictToGuess(predictMlp(mlpGs, exampleOf(item, 'live'))))
    }
    extras.set(`${item.id}|full|mlp-synth`, predictToGuess(predictMlp(mlpSynth, exampleOf(item, 'full'))))
    extras.set(`${item.id}|live|mlp-synth`, predictToGuess(predictMlp(mlpSynth, exampleOf(item, 'live'))))
  }
  console.error('training cnn on one giantsteps split and on synthetic loops')
  const cnnTrain = gs.filter((item) => item.fold !== 0)
  const cnnTest = gs.filter((item) => item.fold === 0)
  const cnn = trainCnn(cnnTrain.map((item) => exampleOf(item, 'full')), 4)
  const cnnFromSynth = trainCnn(synth.map((item) => exampleOf(item, 'full')), 4)
  for (const item of items) {
    if (!item.truth) continue
    if (item.dataset === 'giantsteps+' && item.fold === 0) {
      extras.set(`${item.id}|full|cnn-split`, predictToGuess(predictCnn(cnn, item.analysis.cqtFull)))
      extras.set(`${item.id}|live|cnn-split`, predictToGuess(predictCnn(cnn, item.analysis.cqtLive)))
    } else if (item.dataset !== 'giantsteps+') {
      extras.set(`${item.id}|full|cnn-split`, predictToGuess(predictCnn(cnn, item.analysis.cqtFull)))
      extras.set(`${item.id}|live|cnn-split`, predictToGuess(predictCnn(cnn, item.analysis.cqtLive)))
    }
    extras.set(`${item.id}|full|cnn-synth`, predictToGuess(predictCnn(cnnFromSynth, item.analysis.cqtFull)))
    extras.set(`${item.id}|live|cnn-synth`, predictToGuess(predictCnn(cnnFromSynth, item.analysis.cqtLive)))
  }
  console.error(`classifier bytes mlp ${mlpGs.bytes} cnn ${cnn.bytes}`)
  return { extras, mlpBytes: mlpGs.bytes, cnnBytes: cnn.bytes, cnnTest: cnnTest.length, cnnTrain: cnnTrain.length }
}

function buildSummary(items: Item[], learned: LearnedPack, classifiers: { extras: Map<string, Guess | null>; mlpBytes: number; cnnBytes: number; cnnTest: number; cnnTrain: number }, notes: Record<string, number>) {
  const windows: ('full' | 'live')[] = ['full', 'live']
  const methods: Record<string, unknown> = {}
  const keyed = (dataset?: string) => items.filter((item) => item.truth && (!dataset || item.dataset === dataset))
  for (const method of METHODS) {
    const byWindow: Record<string, unknown> = {}
    for (const window of windows) {
      const guesses = asGuessMap(items, items.map((item) => guessOf(item, method, window, learned, classifiers.extras)))
      const lengthOf = (item: Item) => (item.seconds < 4 ? 'short<4s' : 'longer')
      byWindow[window] = {
        giantsteps: scoreRows(keyed('giantsteps+'), guesses),
        beatport: scoreRows(keyed('beatport'), guesses),
        mtg: scoreRows(keyed('mtg'), guesses),
        synthetic: scoreRows(keyed('synthetic'), guesses),
        library: scoreRows(keyed('library'), guesses),
        byFamily: groupScore(items.filter((item) => item.dataset === 'synthetic'), guesses, (item) => item.family),
        byContent: groupScore(items.filter((item) => item.dataset === 'synthetic' || item.dataset === 'library'), guesses, (item) => item.content),
        byTexture: groupScore(items.filter((item) => item.dataset === 'synthetic'), guesses, (item) => item.texture),
        byLength: groupScore(items, guesses, lengthOf),
        gsTexture: groupScore(keyed('giantsteps+'), guesses, (item) => item.texture),
        gsLength: groupScore(keyed('giantsteps+'), guesses, lengthOf),
        libraryTexture: groupScore(keyed('library'), guesses, (item) => item.texture),
        libraryLength: groupScore(keyed('library'), guesses, lengthOf),
        drums: refusal(items, guesses, 'drum'),
        noise: refusal(items, guesses, 'noise'),
      }
    }
    methods[method] = byWindow
  }
  const thresholds = [0.35, 0.45, 0.55, 0.65, 0.75, 0.85]
  const sweeps: Record<string, unknown> = {}
  for (const method of ['shipped-clear', 'shipped-open', 'hpcp-tuned-edma', 'combined', 'bass-cadence']) {
    sweeps[method] = {}
    for (const window of windows) {
      const base = asGuessMap(items, items.map((item) => guessOf(item, method, window, learned, classifiers.extras)))
      const rows = []
      for (const threshold of thresholds) {
        const gated = new Map<string, Guess | null | undefined>()
        for (const [id, guess] of base) gated.set(id, guess && guess.confidence >= threshold ? guess : guess === undefined ? undefined : null)
        rows.push({
          threshold,
          giantsteps: scoreRows(keyed('giantsteps+'), gated),
          synthetic: scoreRows(keyed('synthetic'), gated),
          library: scoreRows(keyed('library'), gated),
          drums: refusal(items, gated, 'drum'),
        })
      }
      ;(sweeps[method] as Record<string, unknown>)[window] = rows
    }
  }
  const libraryPrior = filenamePrior(items, learned, classifiers.extras)
  const speed = speedOf(items)
  const report = renderReport(methods, sweeps, libraryPrior, speed, classifiers, notes, items)
  return { notes, speed, classifiers: { mlpBytes: classifiers.mlpBytes, cnnBytes: classifiers.cnnBytes, cnnTest: classifiers.cnnTest, cnnTrain: classifiers.cnnTrain }, methods, sweeps, libraryPrior, report }
}

function filenamePrior(items: Item[], learned: LearnedPack, extras: Map<string, Guess | null>) {
  const library = items.filter((item) => item.dataset === 'library' && item.truth)
  const actions: Record<string, number> = {}
  let audioExact = 0
  let keptExact = 0
  for (const item of library) {
    const audio = guessOf(item, 'combined', 'full', learned, extras)
    const truth = item.truth as Truth
    if (audio && sameKey(audio, truth)) audioExact += 1
    let action = 'review'
    let kept: Truth | null = null
    if (!audio || audio.confidence < 0.45) {
      action = 'keep-filename'
      kept = truth
    } else if (sameKey(audio, truth)) {
      action = 'tag-agree'
      kept = audio
    } else if (sameKey(relativeOf(truth.root, truth.mode), audio) && audio.confidence < 0.75) {
      action = 'keep-filename-relative'
      kept = truth
    } else if (audio.confidence >= 0.8) {
      action = 'review-conflict'
      kept = null
    } else {
      action = 'keep-filename'
      kept = truth
    }
    actions[action] = (actions[action] ?? 0) + 1
    if (kept && sameKey(kept, truth)) keptExact += 1
  }
  return {
    n: library.length,
    audioExact,
    audioExactRate: library.length ? Math.round((audioExact / library.length) * 1000) / 1000 : 0,
    priorAgreesWithFilename: keptExact,
    actions,
    note: 'The filename is both the prior and the label, so prior agreement is not detection accuracy.',
  }
}

function speedOf(items: Item[]) {
  const files = items.filter((item) => item.dataset !== 'synthetic')
  const synth = items.filter((item) => item.dataset === 'synthetic')
  const median = (values: number[]) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round(sorted[Math.floor(sorted.length / 2)])
  }
  return {
    files: files.length,
    medianExtractMs: median(files.map((item) => item.analysis.msExtract)),
    medianShippedMs: median(files.map((item) => item.analysis.msShipped)),
    synthMedianExtractMs: median(synth.map((item) => item.analysis.msExtract)),
  }
}

function cell(methods: Record<string, unknown>, method: string, window: string, dataset: string) {
  const block = (((methods[method] as Record<string, unknown>)[window] as Record<string, unknown>)[dataset]) as Tally
  return block
}

function renderReport(methods: Record<string, unknown>, sweeps: Record<string, unknown>, prior: ReturnType<typeof filenamePrior>, speed: ReturnType<typeof speedOf>, classifiers: { mlpBytes: number; cnnBytes: number; cnnTest: number; cnnTrain: number }, notes: Record<string, number>, items: Item[]) {
  const headers = ['Method', 'GS+ full exact / MIREX / relative', 'GS+ live', 'Beatport full', 'MTG full', 'Synth full', 'Library full']
  const rows = METHODS.map((method) => [
    method,
    fmt(cell(methods, method, 'full', 'giantsteps')),
    fmt(cell(methods, method, 'live', 'giantsteps')),
    fmt(cell(methods, method, 'full', 'beatport')),
    fmt(cell(methods, method, 'full', 'mtg')),
    fmt(cell(methods, method, 'full', 'synthetic')),
    fmt(cell(methods, method, 'full', 'library')),
  ])
  const familyHeaders = ['Method', ...['cadence', 'short-mix', 'relative-trap', 'bass-heavy', 'one-shot'].map((name) => name)]
  const familyRows = ['shipped-clear', 'shipped-open', 'hpcp-tuned-edma', 'bass-cadence', 'combined', 'learned-synth', 'mlp-synth'].map((method) => {
    const families = ((methods[method] as Record<string, Record<string, { byFamily: Record<string, Tally> }>>).full.byFamily)
    return [method, ...['cadence', 'short-mix', 'relative-trap', 'bass-heavy', 'one-shot'].map((name) => fmt(families[name]))]
  })
  const lengthRows = ['shipped-clear', 'shipped-open', 'hpcp-tuned-edma', 'combined'].map((method) => {
    const full = (methods[method] as Record<string, Record<string, { byLength: Record<string, Tally>; gsTexture: Record<string, Tally>; libraryLength: Record<string, Tally>; libraryTexture: Record<string, Tally>; drums: { n: number; named: number }; noise: { n: number; named: number } }>>).full
    return [method, fmt(full.byLength['short<4s']), fmt(full.byLength.longer), `${full.drums.named}/${full.drums.n}`, `${full.noise.named}/${full.noise.n}`, fmt(full.gsTexture['bass-heavy']), fmt(full.gsTexture.melodic), fmt(full.libraryLength['short<4s']), fmt(full.libraryTexture['bass-heavy']), fmt(full.libraryTexture.melodic)]
  })
  const sweepRows: string[][] = []
  const sweep = (sweeps.combined as Record<string, { threshold: number; giantsteps: Tally; synthetic: Tally; drums: { n: number; named: number } }[]>).full
  for (const row of sweep) {
    sweepRows.push([
      row.threshold.toFixed(2),
      String(row.giantsteps.n ? row.giantsteps.coverage : 0),
      `${(100 * row.giantsteps.precision).toFixed(1)}%`,
      String(row.giantsteps.relative),
      row.giantsteps.mirex.toFixed(3),
      `${(100 * row.synthetic.precision).toFixed(1)}%`,
      `${row.drums.named}/${row.drums.n}`,
    ])
  }
  const counts = {
    giantsteps: items.filter((item) => item.dataset === 'giantsteps+' && item.truth).length,
    beatport: items.filter((item) => item.dataset === 'beatport' && item.truth).length,
    mtg: items.filter((item) => item.dataset === 'mtg' && item.truth).length,
    synthetic: items.filter((item) => item.dataset === 'synthetic' && item.truth).length,
    library: items.filter((item) => item.dataset === 'library' && item.truth).length,
    drums: items.filter((item) => item.content === 'drum').length,
    noise: items.filter((item) => item.content === 'noise').length,
  }
  return `# Key detection lab

Draft measurement only. The shipped detector is unchanged. No library tags were written and nothing was uploaded.

Counts: GiantSteps+ ${counts.giantsteps} (excluded labels ${notes.gsExcluded}), Beatport ${counts.beatport} (excluded ${notes.beatExcluded}), MTG manual labels matched to local audio ${counts.mtg} of ${notes.mtgAnnotations}, synthetic keyed clips ${counts.synthetic}, filename-labeled library sample ${counts.library}, drum loops ${counts.drums}, noise ${counts.noise}.

MIREX weights: exact 1, same-mode fifth 0.5, relative major/minor 0.3, parallel 0.2, other and unsure 0. Each cell is exact rate / MIREX / relative-error count. Live is the first 24 seconds. Full is the excerpt, capped at 120 seconds.

${mdTable(headers, rows)}

## Synthetic loops by family

${mdTable(familyHeaders, familyRows)}

## Length and drum refusal

Short means under 4 seconds. Drum loops have no key; naming one is a false key.

${mdTable(['Method', 'All short <4s', 'All longer', 'Drums named', 'Noise named', 'GS+ bass-heavy', 'GS+ melodic', 'Library short', 'Library bass-heavy', 'Library melodic'], lengthRows)}

## Confidence sweep on the combined prototype

Accept the guess only when confidence is at least the threshold. Precision is exactness among accepted GiantSteps+ tracks. Coverage is the fraction accepted.

${mdTable(['Threshold', 'GS+ coverage', 'GS+ precision', 'GS+ relative count', 'GS+ MIREX of accepted', 'Synth precision', 'Drums still named'], sweepRows)}

## Library filename prior

Sample n=${prior.n}. Audio-only exact agreement with the filename: ${prior.audioExact} (${prior.audioExactRate}). ${prior.note}

Actions: ${JSON.stringify(prior.actions)}.

## Size and speed

Shipped detector, median ${speed.medianShippedMs} ms per file. Prototype extract, median ${speed.medianExtractMs} ms per file (synthetic median ${speed.synthMedianExtractMs} ms). MLP weights ${classifiers.mlpBytes} bytes. CNN weights ${classifiers.cnnBytes} bytes. The CNN number is one held-out GiantSteps+ fold (train ${classifiers.cnnTrain}, test ${classifiers.cnnTest}), not a five-fold mean. Neither model is imported by the app.

Profiles compared on the same tuned HPCP: Essentia's EDMA numbers, the Faraldo EDMA vector already in the app, Temperley, Krumhansl, Shaath, and the app's three-profile blend. Learned profiles are averages of tuned HPCPs, rotated to the tonic, fit without the evaluation fold.
`
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

void PROFILE_IDS
