import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { isBlockedStatic } from './src/model/libraryHost'

function dropLibraryFiles() {
  return {
    name: 'drop-library-files',
    apply: 'build' as const,
    async closeBundle() {
      const dist = path.resolve('dist')
      await strip(dist, dist)
    },
  }
}

async function strip(dir: string, root: string) {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(dir, name)
    const relative = path.relative(root, file).split(path.sep).join('/')
    const info = await stat(file)
    if (info.isDirectory()) {
      if (isBlockedStatic(relative)) await rm(file, { recursive: true, force: true })
      else await strip(file, root)
      continue
    }
    if (isBlockedStatic(relative) || (info.size > 2 * 1024 * 1024 && !relative.startsWith('assets/'))) {
      await rm(file, { force: true })
    }
  }
}

export default defineConfig({
  plugins: [react(), dropLibraryFiles()],
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
