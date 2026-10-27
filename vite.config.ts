import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))

/** The external ONNX Runtime build fetches WASM from wasmPaths. Refuse a bundled copy. */
function dropBundledOrt(): Plugin {
  return {
    name: 'drop-bundled-ort',
    buildStart() {
      rmSync(resolve(root, 'public/ort'), { recursive: true, force: true })
    },
    generateBundle(_options, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        const name = item.fileName || fileName
        if (name.endsWith('.wasm') || name.includes('ort-wasm')) {
          this.error(`ONNX Runtime files must not ship in the build (${name}). They load from jsDelivr.`)
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), dropBundledOrt()],
  resolve: {
    alias: [
      { find: 'onnxruntime-web/wasm', replacement: resolve(root, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs') },
      { find: 'onnxruntime-web/webgpu', replacement: resolve(root, 'node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs') },
    ],
  },
  worker: {
    // The bounce worker loads plugins with dynamic import, which Rollup cannot emit as iife.
    format: 'es',
  },
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
