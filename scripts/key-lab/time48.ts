/**
 * Median Detect cost at 48 kHz on a 24 second window.
 * Android interactive audio in this app runs at 48 kHz.
 * This does not change the detector.
 */

import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { analysePcm } from './worker.ts'

function decode(path: string, sampleRate: number, seconds: number) {
  return new Promise<Float32Array>((done, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-t', String(seconds), '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'])
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg ${code}`))
      else {
        const bytes = Buffer.concat(chunks)
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        done(new Float32Array(copy))
      }
    })
  })
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] || 0
}

const dir = '/tmp/key-lab/audio-gsplus/audio'
const files = readdirSync(dir).filter((name) => name.endsWith('.mp3') && !name.startsWith('._')).slice(0, 8)
const shipped: number[] = []
const proto: number[] = []
for (const name of files) {
  const samples = await decode(`${dir}/${name}`, 48000, 24)
  const result = analysePcm(samples, 48000)
  proto.push(result.msExtract)
  shipped.push(result.msShipped)
  console.error(name, 'proto', Math.round(result.msExtract), 'shipped', Math.round(result.msShipped))
}
console.log(JSON.stringify({
  files: files.length,
  rate: 48000,
  seconds: 24,
  medianPrototypeMs: Math.round(median(proto)),
  medianShippedMs: Math.round(median(shipped)),
}, null, 2))
