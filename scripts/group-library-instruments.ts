/**
 * Group a private catalog gzip into instruments and print the counts.
 * The server does this when it loads the catalog, so nothing here is uploaded.
 *
 *   npx tsx scripts/group-library-instruments.ts path/to/catalog.json.gz
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { groupLibraryInstruments } from '../src/library/group.ts'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npx tsx scripts/group-library-instruments.ts <catalog.json.gz>')
  process.exit(1)
}
const doc = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as { entries?: unknown[] }
const entries = (doc.entries ?? []).map((item) => {
  const raw = item as Record<string, unknown>
  return {
    key: typeof raw.key === 'string' ? raw.key : '',
    size: typeof raw.size === 'number' ? raw.size : 0,
    pack: typeof raw.pack === 'string' ? raw.pack : '',
    type: typeof raw.type === 'string' ? raw.type : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    root: typeof raw.root === 'string' ? raw.root : '',
  }
})
const notes = entries.filter((entry) => entry.type === 'multisample note').length
const instruments = groupLibraryInstruments(entries)
const singles = instruments.filter((item) => item.notes <= 1)
const sizes = instruments.map((item) => item.samples).sort((a, b) => a - b)
const at = (ratio: number) => sizes[Math.min(sizes.length - 1, Math.floor((sizes.length - 1) * ratio))] ?? 0
console.log(`notes ${notes}`)
console.log(`instruments ${instruments.length}`)
console.log(`single-note ${singles.length}`)
console.log(`samples min ${sizes[0] ?? 0} median ${at(0.5)} p99 ${at(0.99)} max ${sizes[sizes.length - 1] ?? 0}`)
console.log('largest')
for (const item of instruments.slice().sort((a, b) => b.samples - a.samples).slice(0, 8)) {
  console.log(`  ${item.samples}\t${item.notes} notes\t${item.name}`)
}
