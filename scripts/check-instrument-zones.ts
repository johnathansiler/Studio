import { readFileSync } from 'node:fs'
import { selectLayers } from '../src/audio/multisample/map.ts'
import { parseHarborCatalog } from '../src/harbor/parse.ts'
import { instrumentSampleRoot, listInstrumentFiles, prepareCatalogInstrument } from '../src/harbor/load.ts'
import { datasetFilePath } from '../src/harbor/reconcile.ts'

/**
 * Every catalog zone URL must be a file in the public Hugging Face tree.
 * The tree is the dataset listing; a listed file resolves, a missing path 404s.
 * Run: npx tsx scripts/check-instrument-zones.ts
 */

const OSI_MISSING = [
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_B2_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_B2_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_C3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_C3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_D3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_D3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_E3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_E3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_F3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_F3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_D3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_D3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_E3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_E3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_F3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_F3_vl2.flac',
]

async function fetchRetry(input: string, init?: RequestInit) {
  let last: Response | null = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(input, init)
    last = response
    if (response.status !== 429 && response.status < 500) return response
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
  }
  return last ?? fetch(input, init)
}

const catalog = parseHarborCatalog(JSON.parse(readFileSync(new URL('../src/test/fixtures/instrument-library.json', import.meta.url), 'utf8')))
let failed = 0
let encoded: string | null = null

for (const instrument of catalog.instruments) {
  const program = await prepareCatalogInstrument(instrument, fetchRetry)
  const listed = new Set(await listInstrumentFiles(instrumentSampleRoot(instrument.path), fetchRetry, false))
  if (!program) {
    console.error(`${instrument.id}: no program`)
    failed += 1
    continue
  }
  const missing: string[] = []
  for (const sample of program.samples) {
    if (!sample.url) {
      missing.push('(empty url)')
      continue
    }
    const path = datasetFilePath(sample.url)
    if (!listed.has(path)) missing.push(path || sample.url)
    if (!encoded && /%[0-9A-F]{2}/i.test(sample.url)) encoded = sample.url
  }
  const holes: string[] = []
  for (let note = 21; note <= 108; note += 1) {
    const mapped = selectLayers(program, {
      note,
      velocity: 100,
      keyswitch: program.defaultSwitch,
      roundRobin: {},
      trigger: 'attack',
    })
    if (!mapped.layers.length) holes.push(String(note))
  }
  if (instrument.id === 'osiris-piano') {
    const urls = program.samples.map((sample) => datasetFilePath(sample.url))
    const still = OSI_MISSING.filter((path) => urls.includes(path))
    if (still.length) {
      console.error(`osiris-piano still requests ${still.length} missing files`)
      failed += 1
    }
  }
  if (missing.length || holes.length) {
    console.error(`${instrument.id}: ${missing.length} unresolved, ${holes.length} silent keys`)
    for (const path of missing.slice(0, 12)) console.error(`  ${path}`)
    if (holes.length) console.error(`  holes ${holes.slice(0, 8).join(' ')}`)
    failed += 1
  } else {
    console.log(`${instrument.id}: ${program.zones.length} zones, ${program.samples.length} samples`)
  }
}

if (encoded) {
  const head = await fetchRetry(encoded, { method: 'HEAD', redirect: 'manual' })
  const ok = head.status === 200 || head.status === 302 || head.status === 307
  console.log(`encoded url ${head.status} ${encoded.slice(encoded.lastIndexOf('/') + 1)}`)
  if (!ok) {
    console.error('an encoded catalog url did not resolve')
    failed += 1
  }
}

if (failed) {
  console.error(`${failed} instrument${failed === 1 ? '' : 's'} still reference a missing file or a silent key`)
  process.exit(1)
}
console.log(`${catalog.instruments.length} instruments, every zone url is in the dataset listing`)
