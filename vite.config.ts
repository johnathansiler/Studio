import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const ortFiles = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

function ortAssets() {
  const root = dirname(fileURLToPath(import.meta.url))
  const copy = () => {
    const to = resolve(root, 'public/ort')
    mkdirSync(to, { recursive: true })
    for (const name of ortFiles) copyFileSync(resolve(root, 'node_modules/onnxruntime-web/dist', name), resolve(to, name))
  }
  return { name: 'ort-assets', buildStart: copy, configureServer: copy }
}

export default defineConfig({
  plugins: [react(), ortAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
  },
})
