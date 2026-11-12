import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

describe('production server', () => {
  it('boots with node --experimental-strip-types and answers / with 200', async () => {
    const port = await freePort()
    const dir = mkdtempSync(path.join(tmpdir(), 'cueharbor-static-'))
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>CueHarbor</title>')
    const logs: string[] = []
    const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: '127.0.0.1',
        STATIC_DIR: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
    child.stderr?.on('data', (chunk) => logs.push(String(chunk)))
    try {
      const started = Date.now()
      let status = 0
      let body = ''
      let failure = ''
      while (Date.now() - started < 15000) {
        if (child.exitCode != null) {
          failure = `server exited ${child.exitCode}`
          break
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`)
          status = response.status
          body = await response.text()
          if (status === 200) break
        } catch { /* still booting */ }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(failure, logs.join('')).toBe('')
      expect(status, logs.join('')).toBe(200)
      expect(body).toContain('CueHarbor')
    } finally {
      if (child.exitCode == null) child.kill('SIGTERM')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)
})
