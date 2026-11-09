import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { build, type Plugin } from 'vite'

const cache = new Map<string, string>()

/** One self-contained module. AudioWorklet cannot `import()` or load another chunk. */
export async function bundleWorklet(entry: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    clearScreen: false,
    worker: {
      format: 'es',
      plugins: () => [stubNestedWorklets()],
      rollupOptions: { output: { inlineDynamicImports: true, format: 'es' } },
    },
    plugins: [stubNestedWorklets()],
    build: {
      write: false,
      outDir: '/tmp/cueharbor-worklet-bundle',
      target: 'es2022',
      minify: false,
      emptyOutDir: true,
      rollupOptions: {
        input: entry,
        output: {
          format: 'es',
          inlineDynamicImports: true,
        },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => ('output' in item ? item.output : []))
  const chunks = outputs.filter((item) => item.type === 'chunk')
  if (chunks.length !== 1) {
    throw new Error(`${entry} emitted ${chunks.length} chunks. Worklets must be a single file.`)
  }
  const code = chunks[0].code
  assertWorkletSource(code, entry)
  return code
}

/** Fail the build when a worklet still has a module import. */
export function assertWorkletSource(code: string, label: string) {
  if (code.includes('import(')) throw new Error(`${label} contains import(), which WorkletGlobalScope rejects`)
  if (/(^|[\n;])\s*import[\s{"'*]/.test(code)) throw new Error(`${label} contains an import statement, which this worklet build does not allow`)
}

function stubNestedWorklets(): Plugin {
  return {
    name: 'stub-nested-worklets',
    enforce: 'pre',
    resolveId(source) {
      if (!source.includes('worklet') || !source.includes('worker')) return null
      return '\0nested-worklet-stub'
    },
    load(id) {
      if (id !== '\0nested-worklet-stub') return null
      return 'export default "/worklet-stub.js"'
    },
  }
}

/** Runs after Vite's worker plugin so a late chunk cannot sneak in an import(). */
export function workletSourceGuard(): Plugin {
  return {
    name: 'worklet-source-guard',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        if (!fileName.includes('worklet')) continue
        const code = item.type === 'chunk'
          ? item.code
          : typeof item.source === 'string'
            ? item.source
            : item.source
              ? new TextDecoder().decode(item.source)
              : ''
        if (!code) continue
        if (code.includes('import(') || /(^|[\n;])\s*import[\s{"']/.test(code)) {
          delete bundle[fileName]
        }
      }
    },
  }
}

export function selfContainedWorklets(): Plugin {
  const served = new Map<string, string>()
  return {
    name: 'self-contained-worklets',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!/worklet/i.test(source) || !/worker/.test(source)) return null
      const file = source.split('?')[0]
      const abs = resolve(importer ? dirname(importer) : process.cwd(), file)
      return `\0self-worklet:${abs}`
    },
    async load(id) {
      if (!id.startsWith('\0self-worklet:')) return null
      const abs = id.slice('\0self-worklet:'.length)
      if (process.env.VITEST) return 'export default "/worklet-stub.js"'
      let code = cache.get(abs)
      if (!code) {
        code = await bundleWorklet(abs)
        cache.set(abs, code)
      }
      const name = `${basename(abs).replace(/\.ts$/, '')}-${createHash('sha256').update(code).digest('hex').slice(0, 8)}.js`
      if (this.environment?.config?.command !== 'build') {
        served.set(name, code)
        return `export default ${JSON.stringify(`/@self-worklet/${name}`)}`
      }
      const ref = this.emitFile({ type: 'asset', name, source: code })
      return `export default import.meta.ROLLUP_FILE_URL_${ref}`
    },
    generateBundle(_options, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        if (!fileName.includes('worklet')) continue
        const code = item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : ''
        if (!code) continue
        assertWorkletSource(code, fileName)
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        const prefix = '/@self-worklet/'
        if (!url.startsWith(prefix)) return next()
        const body = served.get(url.slice(prefix.length))
        if (!body) return next()
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.end(body)
      })
    },
  }
}
