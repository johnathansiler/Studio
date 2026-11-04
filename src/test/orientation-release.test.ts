import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LANDSCAPE_LOCK,
  RESTORE_LOCK,
  browserLandscapeHost,
  dismissKeyboard,
  forgetLandscapeLock,
  keepLandscapeAfterClose,
  keyboardShellTurn,
  portraitReported,
  presentKeyboard,
  releaseOrientation,
} from '../ui/keyboardStage'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface ScreenState {
  type: string
  angle: number
  fullscreen: Element | null
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else if (/\.(ts|tsx|css|js|mjs)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) out.push(path)
  }
  return out
}

function lockArguments(source: string): string[] {
  return [...source.matchAll(/\block\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
}

describe('upright portrait', () => {
  it('treats 180° and the upside-down portrait as not upright', () => {
    expect(portraitReported('portrait-primary', 0)).toBe(true)
    expect(portraitReported('portrait-primary', null)).toBe(true)
    expect(portraitReported(undefined, 0)).toBe(true)
    expect(portraitReported('portrait-secondary', 180)).toBe(false)
    expect(portraitReported('portrait-secondary', 0)).toBe(false)
    expect(portraitReported('portrait-primary', 180)).toBe(false)
    expect(portraitReported(undefined, 180)).toBe(false)
    expect(portraitReported(undefined, -180)).toBe(false)
    expect(portraitReported('landscape-primary', 90)).toBe(false)
    expect(portraitReported('portrait', 0)).toBe(false)
    expect(keepLandscapeAfterClose(true, { type: 'portrait-secondary', angle: 180 })).toBe(true)
    expect(keepLandscapeAfterClose(true, { type: 'portrait-primary', angle: 0 })).toBe(false)
  })

  it('turns the keyboard shell sideways, and 180° is a different turn from upright portrait', () => {
    expect(keyboardShellTurn(0)).toBe('landscape')
    expect(keyboardShellTurn(90)).toBe('landscape')
    expect(keyboardShellTurn(null)).toBe('landscape')
    expect(keyboardShellTurn(180)).toBe('upside-down')
    expect(keyboardShellTurn(-180)).toBe('upside-down')
    expect(keyboardShellTurn(180)).not.toBe(keyboardShellTurn(0))

    const css = readFileSync(resolve(rootDir, 'src/styles.css'), 'utf8')
    const side = css.slice(css.indexOf('.shell.phone.keys-landscape {'), css.indexOf('.shell.phone.orient-180 {'))
    const inverted = css.slice(css.indexOf('.shell.phone.orient-180 {'), css.indexOf('.shell.phone.keys-landscape .keyboard-dock'))
    expect(side).toContain('rotate(90deg)')
    expect(inverted).toContain('rotate(180deg)')
    expect(inverted).not.toContain('rotate(90deg)')
    expect(inverted).not.toContain('transform: none')
    const app = readFileSync(resolve(rootDir, 'src/App.tsx'), 'utf8')
    expect(app).toContain("keyboardShellTurn(screenAngle) === 'upside-down' ? 'orient-180'")
  })
})

describe('screen orientation restore', () => {
  let calls: string[]
  let state: ScreenState
  let restore: () => void
  let root: HTMLElement
  let orientation: {
    type: string
    angle: number
    lock: (kind: string) => Promise<void>
    unlock: () => void | Promise<void>
  }

  beforeEach(() => {
    forgetLandscapeLock()
    calls = []
    state = { type: 'portrait-primary', angle: 0, fullscreen: null }
    const element = { nodeType: 1 } as unknown as Element
    orientation = {
      get type() { return state.type },
      set type(value: string) { state.type = value },
      get angle() { return state.angle },
      set angle(value: number) { state.angle = value },
      async lock(kind: string) {
        calls.push(`lock:${kind}`)
        if (kind !== 'landscape' && kind !== 'landscape-primary' && kind !== 'portrait-primary') {
          throw new Error(`refused ${kind}`)
        }
        if (kind === 'portrait-primary') {
          state.type = 'portrait-primary'
          state.angle = 0
          return
        }
        state.type = 'landscape-primary'
        state.angle = 90
      },
      async unlock() {
        calls.push('unlock')
      },
    }
    const previousScreen = Object.getOwnPropertyDescriptor(globalThis, 'screen')
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: { orientation } })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        fullscreenEnabled: true,
        get fullscreenElement() { return state.fullscreen },
        async exitFullscreen() {
          calls.push('exit')
          state.fullscreen = null
        },
      },
    })
    root = {
      async requestFullscreen() {
        calls.push('enter')
        state.fullscreen = element
      },
    } as unknown as HTMLElement
    restore = () => {
      forgetLandscapeLock()
      if (previousScreen) Object.defineProperty(globalThis, 'screen', previousScreen)
      else delete (globalThis as { screen?: unknown }).screen
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else delete (globalThis as { document?: unknown }).document
    }
  })

  afterEach(() => {
    restore()
  })

  it('locks landscape-primary, then unlocks, restores portrait-primary, and leaves fullscreen', async () => {
    expect(LANDSCAPE_LOCK).toBe('landscape-primary')
    expect(RESTORE_LOCK).toBe('portrait-primary')
    expect(await presentKeyboard(browserLandscapeHost(root, 'phone', true))).toBe('locked')
    expect(calls).toEqual(['enter', 'lock:landscape-primary'])
    const closed = await dismissKeyboard(browserLandscapeHost(root, 'phone', true), 'locked')
    expect(closed.holdLandscape).toBe(true)
    expect(calls).toEqual(['enter', 'lock:landscape-primary', 'unlock', 'lock:portrait-primary', 'unlock', 'exit'])
    expect(state.type).toBe('portrait-primary')
    expect(state.angle).toBe(0)
    expect(state.fullscreen).toBeNull()
  })

  it('still locks portrait-primary when unlock comes back upside down', async () => {
    let unlocks = 0
    orientation.unlock = async () => {
      calls.push('unlock')
      unlocks += 1
      if (unlocks === 1) {
        state.type = 'portrait-secondary'
        state.angle = 180
      }
    }
    expect(await presentKeyboard(browserLandscapeHost(root, 'phone', true))).toBe('locked')
    const result = await releaseOrientation()
    expect(result.nudged).toBe(true)
    expect(result.exitedFullscreen).toBe(true)
    expect(calls.filter((call) => call.startsWith('lock:'))).toEqual(['lock:landscape-primary', 'lock:portrait-primary'])
    expect(calls).not.toContain('lock:portrait')
    expect(calls).not.toContain('lock:any')
    expect(calls).not.toContain('lock:portrait-secondary')
    expect(state.type).toBe('portrait-primary')
    expect(state.angle).toBe(0)
  })

  it('skips the portrait-primary nudge when unlock already restored upright portrait', async () => {
    orientation.unlock = async () => {
      calls.push('unlock')
      state.type = 'portrait-primary'
      state.angle = 0
    }
    expect(await presentKeyboard(browserLandscapeHost(root, 'phone', true))).toBe('locked')
    const result = await releaseOrientation()
    expect(result.nudged).toBe(false)
    expect(result.exitedFullscreen).toBe(true)
    expect(calls).toEqual(['enter', 'lock:landscape-primary', 'unlock', 'exit'])
  })

  it('does not leave fullscreen that was already open before the lock', async () => {
    state.fullscreen = { nodeType: 1 } as unknown as Element
    expect(await presentKeyboard(browserLandscapeHost(root, 'phone', true))).toBe('locked')
    expect(calls).toEqual(['lock:landscape-primary'])
    await releaseOrientation()
    expect(calls).not.toContain('exit')
    expect(calls).toContain('lock:portrait-primary')
  })

  it('ignores a missing orientation API and rejected lock promises', async () => {
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: {} })
    await expect(releaseOrientation()).resolves.toEqual({ nudged: false, exitedFullscreen: false })
    await expect(presentKeyboard(browserLandscapeHost(root, 'phone', true))).resolves.toBe('shell')

    Object.defineProperty(globalThis, 'screen', { configurable: true, value: { orientation } })
    expect(await presentKeyboard(browserLandscapeHost(root, 'phone', true))).toBe('locked')
    orientation.unlock = async () => {
      throw new Error('rejected unlock')
    }
    orientation.lock = async (kind: string) => {
      calls.push(`lock:${kind}`)
      throw new Error('rejected lock')
    }
    await expect(releaseOrientation()).resolves.toMatchObject({ nudged: false })
    orientation.unlock = () => {
      throw new Error('sync unlock')
    }
    await expect(releaseOrientation()).resolves.toMatchObject({ exitedFullscreen: false })
  })

  it('never requests an upside-down or generic portrait lock', () => {
    const allowed = new Set(['landscape', 'landscape-primary', 'portrait-primary'])
    const files = filesUnder(resolve(rootDir, 'src'))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      for (const kind of lockArguments(readFileSync(file, 'utf8'))) {
        expect(allowed.has(kind), `${file} locks ${kind}`).toBe(true)
      }
    }
    const pads = readFileSync(resolve(rootDir, 'src/ui/PadsPanel.tsx'), 'utf8')
    const app = readFileSync(resolve(rootDir, 'src/App.tsx'), 'utf8')
    const stage = readFileSync(resolve(rootDir, 'src/ui/keyboardStage.ts'), 'utf8')
    expect(pads).toContain('releaseOrientation()')
    expect(app).toContain('releaseOrientation()')
    expect(stage).toContain('releaseOrientation(')
    expect(stage).not.toMatch(/lock\(\s*['"]portrait['"]\s*\)/)
    expect(stage).not.toMatch(/lock\(\s*['"]any['"]\s*\)/)
    expect(stage).not.toMatch(/lock\(\s*['"]portrait-secondary['"]\s*\)/)
  })
})
