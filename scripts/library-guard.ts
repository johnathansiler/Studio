import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { APP_SHELL_BUDGET, isBlockedStatic, libraryViolations } from '../src/model/libraryHost.ts'

const root = path.resolve(import.meta.dirname, '..')
const problems: string[] = []

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean)
for (const relative of tracked) {
  if (!/\.(ts|tsx|js|mjs|css|html|json|md|yml|yaml|webmanifest)$/.test(relative)) continue
  const text = await readFile(path.join(root, relative), 'utf8')
  for (const url of libraryViolations(text)) problems.push(`${relative}: ${url}`)
}

const dist = path.join(root, 'dist')
let shell = 0
await walk(dist)

if (shell > APP_SHELL_BUDGET) problems.push(`app shell is ${shell} bytes, budget is ${APP_SHELL_BUDGET}`)
if (!problems.length && shell === 0) problems.push('dist is missing, so the shell size was not checked')

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`library guard ok, app shell ${shell} bytes`)

async function walk(dir: string) {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(dir, name)
    const info = await stat(file)
    const relative = path.relative(dist, file).split(path.sep).join('/')
    if (info.isDirectory()) {
      if (isBlockedStatic(relative)) problems.push(`dist has library path ${relative}`)
      else await walk(file)
      continue
    }
    if (isBlockedStatic(relative)) problems.push(`dist serves ${relative}`)
    if (relative.startsWith('assets/') && /\.(js|css)$/.test(name)) shell += info.size
  }
}
