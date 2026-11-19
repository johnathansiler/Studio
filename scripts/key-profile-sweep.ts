/**
 * Compare key profiles on guitar renders and a slice of GiantSteps.
 * Prints exact rates. Does not write tags.
 */
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { estimateProfiles, type KeyProfile } from '../src/analysis/keyEstimate.ts'
import { parseMusicalKey } from '../src/library/musicalKey.ts'
import { renderLoop } from './key-benchmark.ts'

const PROFILES: KeyProfile[] = ['edma', 'temperley', 'krumhansl', 'blend']

function tally(rows: { profile: KeyProfile; exact: boolean }[]) {
  for (const profile of PROFILES) {
    const slice = rows.filter((row) => row.profile === profile)
    const exact = slice.filter((row) => row.exact).length
    console.log(`${profile} ${exact}/${slice.length} = ${slice.length ? (exact / slice.length).toFixed(3) : 'n/a'}`)
  }
}

function ffmpeg(path: string) {
  return new Promise<Float32Array>((done, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'])
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

function mapLabel(raw: string) {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text || text.includes('|')) return null
  const match = text.match(/^([A-Ga-g][#b♯♭]?)\s+(.+)$/)
  if (!match) return null
  const rest = match[2].toLowerCase().replace('phryrgian', 'phrygian')
  if (/\bother\b/.test(rest)) return null
  const mode = /(major|ionian|lydian|mixolydian)/.test(rest) ? 'major' : /(minor|aeolian|dorian|phrygian|locrian|harmonic|melodic)/.test(rest) ? 'minor' : ''
  if (!mode) return null
  return parseMusicalKey(`${match[1]} ${mode}`)
}

async function main() {
  const guitar: { profile: KeyProfile; exact: boolean }[] = []
  for (let root = 0; root < 12; root++) {
    for (const mode of ['major', 'minor'] as const) {
      for (const drums of [false, true]) {
        const buffer = renderLoop({ root, mode, bpm: 120, bars: 8, texture: 'guitar', drums })
        const found = estimateProfiles(buffer, 48000, true)
        for (const profile of PROFILES) {
          const row = found[profile]
          guitar.push({ profile, exact: Boolean(row.clear && row.root === root && (row.scale === 'aeolian') === (mode === 'minor')) })
        }
      }
    }
  }
  console.log('guitar 8-bar')
  tally(guitar)

  const audioDir = '/tmp/key-benchmark/audio'
  const keyDir = '/tmp/key-benchmark/keys/keys_gs+'
  const names = (await readdir(audioDir)).filter((name) => name.endsWith('.mp3')).slice(0, 36)
  const giant: { profile: KeyProfile; exact: boolean }[] = []
  for (const name of names) {
    const id = name.match(/(\d{4,})/)?.[1]
    if (!id) continue
    const keys = (await readdir(keyDir)).find((file) => file.startsWith(id))
    if (!keys) continue
    const raw = await readFile(resolve(keyDir, keys), 'utf8')
    const truth = mapLabel(raw)
    if (!truth) continue
    const samples = await ffmpeg(resolve(audioDir, name))
    const found = estimateProfiles(samples, 44100, false)
    for (const profile of PROFILES) {
      const row = found[profile]
      giant.push({ profile, exact: Boolean(row.clear && row.root === truth.root && (row.scale === 'aeolian') === (truth.mode === 'minor')) })
    }
    console.error(`sweep ${giant.length / 4}`)
  }
  console.log('giantsteps sample')
  tally(giant)
}

main()
