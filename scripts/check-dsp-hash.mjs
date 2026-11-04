import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wasmPath = resolve(root, 'core/target/wasm32-unknown-unknown/release/cueharbor_dsp.wasm')
const modulePath = resolve(root, 'src/audio/wasm/dspBytes.ts')
const hashPath = resolve(root, 'src/audio/wasm/dspBytes.sha256')

function fail(message) {
  console.error(message)
  process.exit(1)
}

let wasm
try {
  wasm = readFileSync(wasmPath)
} catch {
  fail(`Missing ${wasmPath}. Build the DSP before checking the hash.`)
}

const built = createHash('sha256').update(wasm).digest('hex')
const recorded = readFileSync(hashPath, 'utf8').trim().split(/\s+/)[0]
const source = readFileSync(modulePath, 'utf8')
const match = source.match(/export const DSP_WASM_BASE64 =\n\s*"([A-Za-z0-9+/=]+)"/)
if (!match) fail('Could not read DSP_WASM_BASE64 from the committed module.')
const committed = Buffer.from(match[1], 'base64')
const committedHash = createHash('sha256').update(committed).digest('hex')

if (built !== recorded) {
  fail(`Rust WASM ${built} does not match dspBytes.sha256 ${recorded}. Run npm run build:dsp and commit the module.`)
}
if (committedHash !== recorded) {
  fail(`Committed module ${committedHash} does not match dspBytes.sha256 ${recorded}.`)
}
if (committed.length !== wasm.length) {
  fail(`Committed module is ${committed.length} bytes; the Rust build is ${wasm.length}.`)
}
console.log(`DSP WASM matches ${recorded} (${wasm.length} bytes).`)
