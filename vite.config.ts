import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
