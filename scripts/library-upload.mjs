#!/usr/bin/env node
/**
 * Upload a folder of WAV files into the private library, then append catalog rows.
 * The passphrase is read from LIBRARY_ACCESS_KEY and is never printed.
 *
 *   LIBRARY_ACCESS_KEY=... node scripts/library-upload.mjs <folder> <baseUrl>
 *
 * The folder holds the WAV files and catalog-entries.json.
 * A finished object is skipped on the next run. A dropped PUT is tried again.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_BYTES = 60 * 1024 * 1024
const SIGN_BATCH = 50
const APPEND_BATCH = 400

export function formatCounts(counts) {
  return `uploaded ${counts.uploaded}\nskipped ${counts.skipped}\nadded ${counts.added}\nfailed ${counts.failed}\n`
}

function urlKeepsSecret(url, accessKey) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    if (parsed.username === accessKey || parsed.password === accessKey) return false
    for (const value of parsed.searchParams.values()) {
      if (value === accessKey) return false
    }
    return true
  } catch {
    return false
  }
}

function audioKey(key) {
  if (typeof key !== 'string') return false
  const text = key.trim()
  if (!text.startsWith('audio/') || text.length > 512) return false
  if (!text.toLowerCase().endsWith('.wav')) return false
  if (text.includes('\\') || text.includes('://')) return false
  return text.split('/').every((part) => part && part !== '.' && part !== '..')
}

async function walkWavs(folder) {
  const out = []
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      if (name.startsWith('.') || name === 'catalog-entries.json') continue
      const path = join(dir, name)
      const info = await stat(path)
      if (info.isDirectory()) {
        await walk(path)
        continue
      }
      if (!name.toLowerCase().endsWith('.wav')) continue
      out.push({
        path,
        name,
        rel: relative(folder, path).split('\\').join('/'),
        size: info.size,
      })
    }
  }
  await walk(folder)
  return out
}

function matchFile(entry, files) {
  const key = typeof entry.key === 'string' ? entry.key.trim() : ''
  const named = typeof entry.file === 'string' ? entry.file.replace(/\\/g, '/').replace(/^\/+/, '') : ''
  if (named) {
    const hit = files.find((file) => file.rel === named || file.name === basename(named))
    if (hit) return hit
  }
  const base = key.split('/').pop() || ''
  const hits = files.filter((file) => file.name === base || key.endsWith(`/${file.rel}`) || key.endsWith(file.rel))
  if (hits.length === 1) return hits[0]
  return hits.find((file) => key.endsWith(file.rel)) || null
}

async function readProgress(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const done = Array.isArray(parsed?.done) ? parsed.done : []
    return done.filter((item) => typeof item === 'string')
  } catch {
    return []
  }
}

async function writeProgress(path, done) {
  await writeFile(path, JSON.stringify({ done }))
}

async function putWithRetry(url, bytes, fetchImpl, attempts) {
  for (let n = 0; n < attempts; n++) {
    try {
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'content-type': 'audio/wav' },
        body: bytes,
      })
      if (response.ok) return true
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return false
    } catch { /* the next attempt sends the whole file again */ }
    if (n + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 50 * (n + 1)))
  }
  return false
}

/**
 * Upload every matched WAV, skip objects that already landed, then append catalog rows.
 * Counts are the only result. Object keys are not returned.
 */
export async function uploadFolder(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const accessKey = options.accessKey || ''
  if (!accessKey) throw new Error('LIBRARY_ACCESS_KEY is missing.')
  const base = String(options.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('The library base URL is missing.')
  const folder = options.folder
  const parsed = JSON.parse(await readFile(join(folder, 'catalog-entries.json'), 'utf8'))
  const listed = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null
  if (!listed) throw new Error('catalog-entries.json needs an entries list.')
  const files = await walkWavs(folder)
  const progressPath = join(folder, '.library-upload-progress.json')
  const done = new Set(await readProgress(progressPath))
  const counts = { uploaded: 0, skipped: 0, added: 0, failed: 0 }
  const pending = []
  for (const entry of listed) {
    if (!entry || typeof entry !== 'object') {
      counts.failed += 1
      continue
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    const file = matchFile(entry, files)
    if (!audioKey(key) || !file || file.size < 1 || file.size > MAX_BYTES) {
      counts.failed += 1
      continue
    }
    const next = { ...entry, key, size: file.size }
    if (typeof next.format !== 'string' || !next.format) next.format = 'wav'
    delete next.file
    pending.push({ entry: next, file, key })
  }
  const appended = []
  const attempts = options.attempts || 3
  for (let offset = 0; offset < pending.length; offset += SIGN_BATCH) {
    const batch = pending.slice(offset, offset + SIGN_BATCH)
    let body = null
    try {
      const response = await fetchImpl(`${base}/api/library/upload-sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-library-key': accessKey },
        body: JSON.stringify({ keys: batch.map((item) => ({ key: item.key, size: item.file.size })) }),
      })
      body = await response.json().catch(() => null)
      if (!response.ok) body = null
    } catch {
      body = null
    }
    const urls = body && Array.isArray(body.urls) ? body.urls : null
    if (!urls) {
      counts.failed += batch.length
      continue
    }
    const byKey = new Map(urls.filter((item) => item && typeof item.key === 'string').map((item) => [item.key, item]))
    for (const item of batch) {
      const link = byKey.get(item.key)
      if (!link || typeof link.url !== 'string' || !urlKeepsSecret(link.url, accessKey)) {
        counts.failed += 1
        continue
      }
      if (link.exists || done.has(item.key)) {
        counts.skipped += 1
        appended.push(item.entry)
        done.add(item.key)
        continue
      }
      const bytes = await readFile(item.file.path)
      const stored = await putWithRetry(link.url, bytes, fetchImpl, attempts)
      if (!stored) {
        counts.failed += 1
        continue
      }
      counts.uploaded += 1
      done.add(item.key)
      appended.push(item.entry)
      await writeProgress(progressPath, [...done]).catch(() => undefined)
    }
  }
  await writeProgress(progressPath, [...done]).catch(() => undefined)
  for (let offset = 0; offset < appended.length; offset += APPEND_BATCH) {
    const slice = appended.slice(offset, offset + APPEND_BATCH)
    const response = await fetchImpl(`${base}/api/library/catalog-append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-library-key': accessKey },
      body: JSON.stringify({ entries: slice }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error('Could not update the library catalog.')
    counts.added += typeof body?.added === 'number' ? body.added : slice.length
  }
  return counts
}

function isDirectRun() {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  const folder = process.argv[2]
  const baseUrl = process.argv[3]
  const accessKey = process.env.LIBRARY_ACCESS_KEY || ''
  if (!folder || !baseUrl || !accessKey) {
    console.error('Usage: LIBRARY_ACCESS_KEY=... node scripts/library-upload.mjs <folder> <baseUrl>')
    process.exit(1)
  }
  uploadFolder({ folder, baseUrl, accessKey }).then((counts) => {
    process.stdout.write(formatCounts(counts))
    if (counts.failed) process.exitCode = 1
  }).catch((error) => {
    const message = error instanceof Error ? error.message : 'Upload failed.'
    console.error(message.includes(accessKey) ? 'Upload failed.' : message)
    process.exit(1)
  })
}
