import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** A shipped file at or under this size stays on the app host. */
export const MAX_DIST_BYTES = 5 * 1024 * 1024

export function distFiles(dir: string) {
  const out: { path: string; size: number }[] = []
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else out.push({ path, size: stat.size })
    }
  }
  walk(dir)
  return out
}

export function oversized(files: { path: string; size: number }[], limit = MAX_DIST_BYTES) {
  return files.filter((file) => file.size > limit)
}

function megabytes(size: number) {
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? 'dist'
  let files: { path: string; size: number }[]
  try {
    files = distFiles(dir)
  } catch {
    console.error(`check:size could not read ${dir}. Run the production build first.`)
    process.exit(1)
  }
  const big = oversized(files)
  if (big.length) {
    for (const file of big) console.error(`${file.path} ${megabytes(file.size)} exceeds ${megabytes(MAX_DIST_BYTES)}`)
    process.exit(1)
  }
  const largest = files.reduce((best, file) => (file.size > best.size ? file : best), { path: '', size: 0 })
  console.log(`${files.length} files in ${dir}. Largest is ${largest.path || '(empty)'} at ${megabytes(largest.size)}.`)
}
