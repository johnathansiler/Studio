/**
 * One audio file in, chroma plus the shipped detector out.
 * The worker is only used by the key lab.
 */

import { spawn } from 'node:child_process'
import { parentPort } from 'node:worker_threads'
import { detectKey } from '../../src/analysis/clipKey.ts'
import { extract, roundChroma, type ChromaView, type Extracted } from './engine.ts'

function decodeFile(path: string, sampleRate: number) {
  return new Promise<Float32Array>((done, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-t', '120', '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'])
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
      done(new Float32Array(copy))
    })
  })
}

function packChroma(view: ChromaView) {
  return {
    hpcp440: roundChroma(view.hpcp440),
    hpcpTuned: roundChroma(view.hpcpTuned),
    hpcpNoHarm: roundChroma(view.hpcpNoHarm),
    hpcpRaw: roundChroma(view.hpcpRaw),
    bass: roundChroma(view.bass),
    segments: view.segments.map((row) => roundChroma(row)),
    nnls: roundChroma(view.nnls),
    entropy: Math.round(view.entropy * 1000) / 1000,
    lowShare: Math.round(view.lowShare * 1000) / 1000,
    flatness: Math.round(view.flatness * 1000) / 1000,
  }
}

function packReading(samples: Float32Array, sampleRate: number) {
  const reading = detectKey(samples, sampleRate)
  return {
    clear: reading.clear,
    root: reading.root,
    scale: reading.scale,
    confidence: Math.round(reading.confidence * 1000) / 1000,
    label: reading.label,
    bestRoot: reading.best?.root ?? null,
    bestMinor: Boolean(reading.best?.minor),
    bestCorr: Math.round((reading.best?.corr ?? 0) * 1000) / 1000,
    tonal: Math.round(reading.tonal * 1000) / 1000,
  }
}

export interface Analysis {
  seconds: number
  cents: number
  liveCents: number
  frames: number
  msExtract: number
  msShipped: number
  live: ReturnType<typeof packChroma>
  full: ReturnType<typeof packChroma>
  cqtLive: number[][]
  cqtFull: number[][]
  shippedLive: ReturnType<typeof packReading>
  shippedFull: ReturnType<typeof packReading>
}

export function analysePcm(samples: Float32Array, sampleRate: number): Analysis {
  const t0 = performance.now()
  const extracted: Extracted = extract(samples, sampleRate)
  const msExtract = performance.now() - t0
  const t1 = performance.now()
  const shippedFull = packReading(samples, sampleRate)
  const liveCount = Math.min(samples.length, Math.floor(sampleRate * 24))
  const shippedLive = liveCount === samples.length ? shippedFull : packReading(samples.subarray(0, liveCount), sampleRate)
  const msShipped = performance.now() - t1
  const roundGrid = (grid: number[][]) => grid.map((row) => row.map((value) => Math.round(value * 1000) / 1000))
  return {
    seconds: Math.round(extracted.seconds * 1000) / 1000,
    cents: extracted.cents,
    liveCents: extracted.liveCents,
    frames: extracted.frames,
    msExtract,
    msShipped,
    live: packChroma(extracted.live),
    full: packChroma(extracted.full),
    cqtLive: roundGrid(extracted.cqtLive),
    cqtFull: roundGrid(extracted.cqtFull),
    shippedLive,
    shippedFull,
  }
}

export async function analyseFile(path: string, sampleRate = 44100) {
  const samples = await decodeFile(path, sampleRate)
  return analysePcm(samples, sampleRate)
}

if (parentPort) {
  parentPort.on('message', (msg: { id: number; path?: string; sampleRate?: number; pcm?: ArrayBuffer }) => {
    const finish = (payload: unknown) => parentPort?.postMessage(payload)
    const run = msg.path
      ? analyseFile(msg.path, msg.sampleRate ?? 44100)
      : Promise.resolve(analysePcm(new Float32Array(msg.pcm ?? new ArrayBuffer(0)), msg.sampleRate ?? 44100))
    run.then((result) => finish({ id: msg.id, ok: true, result })).catch((error: unknown) => {
      finish({ id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    })
  })
}
