/**
 * Static shots of the play-along sheet at phone and Fold widths.
 * Run: npx tsx scripts/play-along-shots.ts
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { PlayAlongFace } from '../src/ui/PlayAlongFace'

const css = [
  readFileSync('src/ui/playAlong.css', 'utf8'),
  readFileSync('src/ui/sheetClose.css', 'utf8'),
  readFileSync('src/ui/bottomSheet.css', 'utf8'),
].join('\n')

const noop = () => undefined

function page(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --accent: #73c48f; --accent-ink: #102016; --text: #e7f2ea; --line: #2c3c34; --muted: #9bb0a4; }
    html, body { margin: 0; background: #0c1210; color: #e7f2ea; font-family: "Segoe UI", sans-serif; }
    .dock { position: fixed; left: 0; right: 0; bottom: 0; height: 72px; background: #101614; border-top: 1px solid #2c3c34; }
  </style><style>${css}</style><style>.play-along-sheet { animation: none !important; --along-bottom: 72px; }</style></head><body>${body}<div class="dock"></div></body></html>`
}

function face(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(PlayAlongFace, {
    onClose: noop,
    onSpeed: noop,
    onNames: noop,
    onFollow: noop,
    onCount: noop,
    onLoop: noop,
    onA: noop,
    onB: noop,
    onStep: noop,
    onPlay: noop,
    onConvert: noop,
    onKey: noop,
    names: 'letters',
    followKey: true,
    countLabel: '1 bar',
    countOn: true,
    loopOn: false,
    markA: true,
    markB: false,
    playing: true,
    status: '',
    speed: 1,
    ...props,
  }))
}

const midi = face({
  title: 'Verse',
  subtitle: 'MIDI',
  chord: 'Am7',
  bass: 'A3',
  confidence: 'Exact',
  approximate: false,
  beat: 0.15,
  lane: [
    { id: 'a', pitch: 57, startBeat: 0, label: 'A3' },
    { id: 'c', pitch: 60, startBeat: 0, label: 'C4' },
    { id: 'e', pitch: 64, startBeat: 0, label: 'E4' },
    { id: 'g', pitch: 67, startBeat: 0, label: 'G4' },
    { id: 'd', pitch: 62, startBeat: 2, label: 'D4' },
    { id: 'f', pitch: 65, startBeat: 2, label: 'F4' },
    { id: 'a2', pitch: 69, startBeat: 2, label: 'A4' },
  ],
  drums: false,
  pads: [],
  low: 48,
  high: 72,
  lit: [57, 60, 64, 67],
  canConvert: false,
})

const bass = face({
  title: 'Finger bass',
  subtitle: 'Approximate',
  chord: 'E2',
  bass: '',
  confidence: '91% · approximate',
  approximate: true,
  beat: 0.1,
  lane: [
    { id: 'e', pitch: 40, startBeat: 0, label: 'E2' },
    { id: 'g', pitch: 43, startBeat: 1, label: 'G2' },
    { id: 'b', pitch: 47, startBeat: 2, label: 'B2' },
    { id: 'a', pitch: 45, startBeat: 3, label: 'A2' },
  ],
  drums: false,
  pads: [],
  low: 36,
  high: 60,
  lit: [40],
  speed: 0.75,
  canConvert: true,
})

const chords = face({
  title: 'Felt piano',
  subtitle: 'Approximate',
  chord: 'C',
  bass: 'bass C2',
  confidence: '88% · approximate',
  approximate: true,
  beat: 0.2,
  lane: [
    { id: 'c', pitch: 48, startBeat: 0, label: 'C', chord: true },
    { id: 'am', pitch: 45, startBeat: 2, label: 'Am', chord: true },
    { id: 'f', pitch: 41, startBeat: 4, label: 'F', chord: true },
    { id: 'g', pitch: 43, startBeat: 6, label: 'G', chord: true },
  ],
  drums: false,
  pads: [],
  low: 48,
  high: 72,
  lit: [60, 64, 67],
  canConvert: true,
})

const shots = [
  { name: 'play-along-midi', html: midi },
  { name: 'play-along-bass', html: bass },
  { name: 'play-along-chords', html: chords },
]

const viewports = [
  { name: '384', width: 384, height: 840 },
  { name: '884', width: 884, height: 1104 },
]

mkdirSync('/opt/cursor/artifacts', { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' })
for (const shot of shots) {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
    const tab = await context.newPage()
    await tab.setContent(page(shot.html), { waitUntil: 'load' })
    const file = `/opt/cursor/artifacts/${shot.name}-${viewport.name}.png`
    await tab.screenshot({ path: file })
    console.log(file)
    await context.close()
  }
}
await browser.close()
