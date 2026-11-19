/**
 * Second pass: record Detect's top key even when it withholds a clear call.
 * Does not change the detector.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { detectKey } from '../src/analysis/clipKey.ts'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function parseCsv(text: string) {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const cells: string[] = []
    let cur = ''
    let quote = false
    for (const ch of line) {
      if (quote) {
        if (ch === '"') quote = false
        else cur += ch
      } else if (ch === '"') quote = true
      else if (ch === ',') { cells.push(cur); cur = '' }
      else cur += ch
    }
    cells.push(cur)
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
  })
}

function ffmpeg(path: string) {
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'])
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg ${code}`))
      else {
        const bytes = Buffer.concat(chunks)
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        resolve(new Float32Array(copy))
      }
    })
  })
}

function scored(label: string) {
  const [name, mode] = label.split(' ')
  const root = NAMES.indexOf(name)
  if (root < 0 || (mode !== 'major' && mode !== 'minor')) return null
  return { root, mode: mode as 'major' | 'minor' }
}

function relation(truthLabel: string, heardLabel: string) {
  const truth = scored(truthLabel)
  const heard = scored(heardLabel)
  if (!truth || !heard) return 'no-key'
  const up = (heard.root - truth.root + 12) % 12
  if (up === 0 && heard.mode === truth.mode) return 'exact'
  if (up === 0) return 'parallel'
  if (heard.mode !== truth.mode && truth.mode === 'major' && up === 9) return 'relative'
  if (heard.mode !== truth.mode && truth.mode === 'minor' && up === 3) return 'relative'
  if (heard.mode === truth.mode && (up === 7 || up === 5)) return 'fifth'
  if (up === 1 || up === 11) return 'semitone'
  return 'other'
}

async function main() {
  const rows = parseCsv(await readFile('/opt/cursor/artifacts/key-benchmark/giantsteps-benchmark.csv', 'utf8'))
  const manifest = (await readFile('/opt/cursor/artifacts/key-benchmark/giantsteps-manifest.jsonl', 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { id: string; path: string })
  const pathOf = new Map(manifest.map((item) => [item.id, item.path]))
  const out: { id: string; truth: string; best: string; clear: string; relation: string; confidence: string }[] = []
  let n = 0
  for (const row of rows) {
    if (row.relation === 'excluded' || row.relation === 'error' || !row.truth) continue
    const path = pathOf.get(row.id)
    if (!path) continue
    const samples = await ffmpeg(path)
    const reading = detectKey(samples, 44100)
    const best = reading.best?.name ?? ''
    out.push({ id: row.id, truth: row.truth, best, clear: String(reading.clear), relation: best ? relation(row.truth, best) : 'no-key', confidence: reading.confidence.toFixed(3) })
    n += 1
    if (n % 50 === 0) console.error(`open ${n}`)
  }
  const counts: Record<string, number> = {}
  for (const row of out) counts[row.relation] = (counts[row.relation] ?? 0) + 1
  const exact = counts.exact ?? 0
  console.log(JSON.stringify({ n: out.length, exact, exactRate: exact / out.length, counts }, null, 2))
  await writeFile('/opt/cursor/artifacts/key-benchmark/giantsteps-open.json', JSON.stringify({ counts, exact, n: out.length, exactRate: exact / out.length, rows: out }))
}

main()
