import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { STRIP_DEFAULT, writeLayout } from '../model/layoutWidth'
import { ProjectStore } from '../state/store'
import { ArrangeView } from '../ui/ArrangeView'
import { BeatView } from '../ui/BeatView'
import { MixerView } from '../ui/MixerView'
import { SessionView } from '../ui/SessionView'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  'src/styles.css',
  'src/ui/premium.css',
  'src/ui/kit/kit.css',
  'src/ui/automation.css',
  'src/ui/arrangeSpace.css',
  'src/ui/channel-rack.css',
  'src/ui/sessionLive.css',
  'src/ui/sessionGrid.css',
  'src/ui/remoteFixes.css',
  'src/ui/loopRegion.css',
  'src/ui/drumRoll.css',
].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  levels: () => ({ master: 0, input: 0, talk: 0, tracks: {} }),
  masterReading: () => null,
  mixMeters: () => ({ cpu: 0, lufs: -70, truePeak: -70 }),
  stopPreview() {},
  previewPcm() {},
  previewSequence() {},
  unlock() {},
} as unknown as AudioEngine

function pageHtml(body: string, shell: string, width: number, height: number) {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; width: ${width}px; height: ${height}px; }
    ${css}
  </style></head><body>
    <div class="${shell}" style="width:${width}px;height:${height}px">
      <div class="main-pane" style="height:${height - 120}px">${body}</div>
    </div>
  </body></html>`
}

function withWindow<T>(width: number, height: number, draw: () => T): T {
  const previous = globalThis.window
  globalThis.window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis
  try {
    return draw()
  } finally {
    if (previous) globalThis.window = previous
    else delete (globalThis as { window?: Window }).window
  }
}

function arrange(store: ProjectStore) {
  return renderToStaticMarkup(createElement(ArrangeView, {
    store,
    engine,
    session: { state: { participants: [], selfId: 'me' } },
    onSeek() {},
    onOpenPiano() {},
    onPerform() {},
    onQuickPunch() {},
    onAnalyze() {},
  } as never))
}

describe('layout screenshots', () => {
  it('captures arrange, session, mix, drums, and a drag shadow', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      const shot = async (name: string, html: string, width: number, height: number) => {
        const page = await browser.newPage({ viewport: { width, height } })
        await page.setContent(html, { waitUntil: 'load' })
        await page.screenshot({ path: `/opt/cursor/artifacts/${name}.png` })
        await page.close()
      }
      const phone = 'shell studio phone'
      const fold = 'shell studio fold'
      const arrangeStore = new ProjectStore()
      await shot('arrange-412', pageHtml(withWindow(412, 915, () => arrange(arrangeStore)), phone, 412, 915), 412, 915)
      await shot('arrange-923', pageHtml(withWindow(923, 1024, () => arrange(arrangeStore)), fold, 923, 1024), 923, 1024)
      const keys = arrangeStore.project.tracks.find((track) => track.name === 'Keys')!
      arrangeStore.selectTrack(keys.id)
      await shot('arrange-selected-412', pageHtml(withWindow(412, 915, () => arrange(arrangeStore)), phone, 412, 915), 412, 915)

      const session = (store: ProjectStore) => renderToStaticMarkup(createElement(SessionView, {
        store,
        engine,
        onRecord() {},
        onDropAudio() {},
        onOpenPiano() {},
      }))
      const sessionStore = new ProjectStore()
      await shot('session-412', pageHtml(withWindow(412, 915, () => session(sessionStore)), phone, 412, 915), 412, 915)
      await shot('session-923', pageHtml(withWindow(923, 1024, () => session(sessionStore)), fold, 923, 1024), 923, 1024)

      const mix = (store: ProjectStore) => renderToStaticMarkup(createElement(MixerView, { store, engine }))
      const mixStore = new ProjectStore()
      writeLayout(mixStore.project.id, { strip: STRIP_DEFAULT, column: 70, mixer: 'columns' })
      await shot('mix-master-412', pageHtml(withWindow(412, 915, () => mix(mixStore)), phone, 412, 915), 412, 915)
      writeLayout(mixStore.project.id, { strip: STRIP_DEFAULT, column: 148, mixer: 'columns' })
      await shot('mix-master-923', pageHtml(withWindow(923, 1024, () => mix(mixStore)), fold, 923, 1024), 923, 1024)

      const beats = new ProjectStore()
      beats.selectRackChannel(beats.activePattern()!.channels[1].id)
      beats.smartRandomDrums(2)
      const beatHtml = withWindow(412, 915, () => renderToStaticMarkup(createElement(BeatView, { store: beats, engine })))
      await shot('drums-random-412', pageHtml(beatHtml, phone, 412, 915), 412, 915)
      if (!beats.rackRoll) beats.toggleRackRoll()
      const rollHtml = withWindow(412, 915, () => renderToStaticMarkup(createElement(BeatView, { store: beats, engine })))
      await shot('drums-roll-412', pageHtml(rollHtml, phone, 412, 915), 412, 915)

      const song = new ProjectStore()
      song.sendPatternToArrange(0)
      await shot('arrange-notes-412', pageHtml(withWindow(412, 915, () => arrange(song)), phone, 412, 915), 412, 915)
    } finally {
      await browser.close()
    }
  }, 30000)
})
