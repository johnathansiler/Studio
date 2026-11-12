import http from 'node:http'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { sessionOn } from './src/features'
import { isolationHeaders } from './server/headers'
import { LIBRARY_NOT_READY } from './src/library/access'
import { selfContainedWorklets, workletSourceGuard } from './scripts/worklet-bundle'

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

/**
 * The real library route answers 200 { ready: false } when it is not configured.
 * The dev proxy otherwise turns a stopped API into a 500, which the browser logs
 * as soon as My Library asks whether the library is there.
 */
function libraryStatusWithoutApi(): Plugin {
  return {
    name: 'library-status-without-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (req.method !== 'GET' || path !== '/api/library') {
          next()
          return
        }
        const probe = http.get('http://127.0.0.1:8787/api/library', (upstream) => {
          upstream.resume()
          next()
        })
        probe.on('error', () => {
          if (res.writableEnded) return
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ready: false, message: LIBRARY_NOT_READY }))
        })
      })
    },
  }
}

/** COOP/COEP on dev and `vite preview`, matching the production server. */
function isolationPreview(): Plugin {
  const headers = isolationHeaders()
  const apply = (server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      next()
    })
  }
  return {
    name: 'isolation-headers',
    configureServer: apply,
    configurePreviewServer: apply,
  }
}

export default defineConfig({
  define: {
    __CUEHARBOR_SESSION__: JSON.stringify(sessionOn),
  },
  plugins: [selfContainedWorklets(), libraryStatusWithoutApi(), react(), dropBundledOrt(), isolationPreview(), workletSourceGuard()],
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
