/**
 * Two-phone call against a running CueHarbor.
 *
 *   node scripts/prod-call-test.mjs https://cueharbor.onrender.com
 *
 * Host is Chromium with a Galaxy-sized Android profile. Guest is Chromium
 * with an iPhone profile (this environment's WebKit rejects a Chrome VP8
 * offer). Fake camera and microphone. Prints PASS or FAIL plus the host
 * socket count, signaling states, and inbound video/audio bytes over 60s.
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')

const base = (process.argv[2] || process.env.BASE || '').replace(/\/$/, '')
const waitMs = Number(process.env.WAIT || 60000)
if (!base) {
  console.log('FAIL')
  console.log('reason: pass the site URL, for example node scripts/prod-call-test.mjs https://cueharbor.onrender.com')
  process.exit(1)
}

const galaxy = { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
const iphone = { ...devices['iPhone 13'], viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true }

const hook = () => {
  const NativeWS = window.WebSocket
  function PatchedSocket(url, protocols) {
    window.__wsOpens = (window.__wsOpens || 0) + 1
    const sock = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols)
    const mark = (kind, extra) => {
      const row = window.__wsLog || (window.__wsLog = [])
      row.push({ t: Math.round(performance.now()), kind, ready: sock.readyState, ...extra })
    }
    mark('open-ctor', { url: String(url) })
    sock.addEventListener('open', () => mark('open'))
    sock.addEventListener('error', () => mark('error'))
    sock.addEventListener('close', (event) => mark('close', { code: event.code, reason: event.reason }))
    return sock
  }
  PatchedSocket.prototype = NativeWS.prototype
  PatchedSocket.CONNECTING = NativeWS.CONNECTING
  PatchedSocket.OPEN = NativeWS.OPEN
  PatchedSocket.CLOSING = NativeWS.CLOSING
  PatchedSocket.CLOSED = NativeWS.CLOSED
  window.WebSocket = PatchedSocket

  const Native = window.RTCPeerConnection
  function Patched(config) {
    const pc = new Native(config)
    window.__pcs = window.__pcs || []
    window.__pcs.push(pc)
    const offer = pc.createOffer.bind(pc)
    pc.createOffer = async (...args) => {
      window.__offers = (window.__offers || 0) + 1
      return offer(...args)
    }
    return pc
  }
  Patched.prototype = Native.prototype
  window.RTCPeerConnection = Patched
}

async function install(page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices || (navigator.mediaDevices = {})
    md.getUserMedia = async (constraints = {}) => {
      const tracks = []
      if (constraints.video) {
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 120
        const ctx = canvas.getContext('2d')
        let frame = 0
        const draw = () => {
          frame += 1
          if (!ctx) return
          ctx.fillStyle = frame % 2 ? '#246b3f' : '#c4552a'
          ctx.fillRect(0, 0, 160, 120)
        }
        draw()
        setInterval(draw, 100)
        const stream = canvas.captureStream?.(10)
        if (stream?.getVideoTracks().length) tracks.push(stream.getVideoTracks()[0])
      }
      if (constraints.audio) {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const dest = ctx.createMediaStreamDestination()
        osc.connect(dest)
        osc.start()
        tracks.push(dest.stream.getAudioTracks()[0])
      }
      if (!tracks.length) throw new Error('no tracks')
      return new MediaStream(tracks)
    }
  })
  await page.addInitScript(hook)
}

async function sample(page) {
  return page.evaluate(async () => {
    const peers = []
    for (const pc of window.__pcs || []) {
      let video = 0
      let audio = 0
      try {
        const report = await pc.getStats()
        report.forEach((row) => {
          if (row.type === 'inbound-rtp' && row.kind === 'video') video += row.bytesReceived || 0
          if (row.type === 'inbound-rtp' && row.kind === 'audio') audio += row.bytesReceived || 0
        })
      } catch {
        /* closed */
      }
      peers.push({ signaling: pc.signalingState, ice: pc.iceConnectionState, conn: pc.connectionState, video, audio })
    }
    return {
      code: (document.querySelector('.dock-bar strong')?.textContent || '').replace('Session ', '').trim(),
      banner: [...document.querySelectorAll('.media-banner')].map((el) => el.textContent).join(' | '),
      ws: window.__wsOpens || 0,
      offers: window.__offers || 0,
      closes: window.__wsLog || [],
      peers,
    }
  })
}

function line(label, side) {
  const peer = side.peers[0]
  return {
    label,
    ws: side.ws,
    offers: side.offers,
    signaling: peer?.signaling || 'none',
    ice: peer?.ice || 'none',
    video: peer?.video || 0,
    audio: peer?.audio || 0,
    banner: side.banner,
  }
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const hostContext = await browser.newContext(galaxy)
const guestContext = await browser.newContext(iphone)
const host = await hostContext.newPage()
const guest = await guestContext.newPage()
host.on('pageerror', (error) => console.log('HOST PAGE', error.message))
guest.on('pageerror', (error) => console.log('GUEST PAGE', error.message))
await install(host)
await install(guest)
// A fresh pair every run, with the host id sorting first so the host offers and the guest stays polite.
const suffix = randomBytes(6).toString('hex')
await host.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), `00000000-0000-4000-8000-${suffix}`)
await guest.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), `ffffffff-ffff-4fff-8fff-${suffix}`)

let failed = ''
try {
  await host.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await host.getByRole('button', { name: 'Session', exact: true }).click()
  await host.getByRole('button', { name: 'Create invite' }).click()
  const codeLabel = host.locator('.dock-bar strong').filter({ hasText: /Session [A-Z0-9]{6}/ })
  await codeLabel.waitFor({ timeout: 30000 })
  const code = (await codeLabel.innerText()).replace('Session ', '').trim()
  console.log('CODE', code)
  await guest.goto(`${base}/?session=${code}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await guest.getByPlaceholder('Your name').fill('Ava')
  await guest.locator('#join-session').click()
  const reconnect = guest.locator('#tap-reconnect')
  if (await reconnect.isVisible().catch(() => false)) await reconnect.click()
  await guest.getByRole('button', { name: 'Session', exact: true }).click()
  await host.getByRole('button', { name: 'people' }).click()
  await host.locator('.waiting', { hasText: 'Ava' }).getByRole('button', { name: 'Admit' }).click({ timeout: 20000 })
  await host.getByRole('button', { name: 'Session', exact: true }).click()

  const samples = []
  const started = Date.now()
  while (Date.now() - started < waitMs) {
    await host.waitForTimeout(5000)
    const row = { at: Math.round((Date.now() - started) / 1000), host: await sample(host), guest: await sample(guest) }
    samples.push(row)
    console.log(JSON.stringify({ at: row.at, host: line('host', row.host), guest: line('guest', row.guest) }))
  }
  const held = samples[samples.length - 1]
  const diagRes = await host.request.get(`${base}/api/diag/${code}`)
  const diag = diagRes.ok() ? await diagRes.json() : { entries: [], error: diagRes.status() }
  const events = (diag.entries || []).filter((entry) => entry.event)
  const duplicates = events.filter((entry) => entry.event === 'duplicate').length
  const hostPeer = held.host.peers[0]
  const guestPeer = held.guest.peers[0]
  const pass =
    held.host.ws === 1 &&
    held.host.offers <= 1 &&
    duplicates === 0 &&
    hostPeer?.signaling === 'stable' &&
    guestPeer?.signaling === 'stable' &&
    (hostPeer?.video || 0) > 0 &&
    (hostPeer?.audio || 0) > 0 &&
    (guestPeer?.video || 0) > 0 &&
    (guestPeer?.audio || 0) > 0
  console.log(pass ? 'PASS' : 'FAIL')
  console.log('code:', code)
  console.log('hostSockets:', held.host.ws)
  console.log('hostOffers:', held.host.offers)
  console.log('guestOffers:', held.guest.offers)
  console.log('hostSignaling:', hostPeer?.signaling || 'none', 'ice:', hostPeer?.ice || 'none')
  console.log('guestSignaling:', guestPeer?.signaling || 'none', 'ice:', guestPeer?.ice || 'none')
  console.log('hostVideo:', hostPeer?.video || 0, 'hostAudio:', hostPeer?.audio || 0)
  console.log('guestVideo:', guestPeer?.video || 0, 'guestAudio:', guestPeer?.audio || 0)
  console.log('duplicates:', duplicates)
  console.log('serverEvents:', JSON.stringify(events.map((entry) => ({ event: entry.event, note: entry.note }))))
  console.log('hostCloses:', JSON.stringify(held.host.closes.filter((row) => row.kind !== 'open-ctor')))
  if (!pass) process.exitCode = 1
} catch (error) {
  failed = error instanceof Error ? error.message : String(error)
  console.log('FAIL')
  console.log('reason:', failed)
  process.exitCode = 1
} finally {
  await browser.close()
}
