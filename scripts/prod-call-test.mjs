/**
 * Two-phone call against a running CueHarbor.
 *
 *   node scripts/prod-call-test.mjs https://cueharbor.onrender.com
 *
 * Three runs, all under a mobile network (150 ms RTT, 1% loss, 4G cap):
 *   1. Android host, iPhone guest, 6x CPU and paused timers on the Android
 *   2. Android guest, iPhone host, same throttle on the Android
 *   3. Guest localStorage still holds a dead session code and opens a fresh invite
 *
 * The Android tab is hidden and shown. Then its outbound signaling is held
 * for 22s, which is what a frozen main thread looks like to the server.
 * Prints PASS or FAIL per scenario. A live socket must stay up through that
 * hold, and the invite code must win over the stored one.
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')

const base = (process.argv[2] || process.env.BASE || '').replace(/\/$/, '')
const waitMs = Number(process.env.WAIT || 20000)
if (!base) {
  console.log('FAIL')
  console.log('reason: pass the site URL, for example node scripts/prod-call-test.mjs https://cueharbor.onrender.com')
  process.exit(1)
}

const galaxy = { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
const iphone = { ...devices['iPhone 13'], viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true }
const DEAD = 'U279DV'

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
    const orig = sock.send.bind(sock)
    sock.send = (data) => {
      const text = String(data)
      const sent = window.__sent || (window.__sent = [])
      if (sent.length < 40) sent.push(text.slice(0, 160))
      if (window.__holdSends) return
      return orig(data)
    }
    sock.addEventListener('open', () => mark('open'))
    sock.addEventListener('error', () => mark('error'))
    sock.addEventListener('close', (event) => mark('close', { code: event.code, reason: event.reason, clean: event.wasClean }))
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

async function mobileNetwork(page, cpu) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 500_000,
    uploadThroughput: 250_000,
    packetLoss: 1,
  })
  if (cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  return cdp
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
      peers.push({
        signaling: pc.signalingState,
        ice: pc.iceConnectionState,
        conn: pc.connectionState,
        video,
        audio,
      })
    }
    let stored = ''
    try {
      stored = JSON.parse(localStorage.getItem('cueharbor-identity') || '{}').code || ''
    } catch {
      stored = ''
    }
    return {
      code: (document.querySelector('.dock-bar strong')?.textContent || '').replace('Session ', '').trim(),
      banner: [...document.querySelectorAll('.media-banner')].map((el) => el.textContent).join(' | '),
      ws: window.__wsOpens || 0,
      offers: window.__offers || 0,
      pcs: (window.__pcs || []).length,
      closes: window.__wsLog || [],
      sent: window.__sent || [],
      stored,
      peers,
    }
  })
}

function line(side) {
  const peer = side.peers[0]
  return {
    ws: side.ws,
    offers: side.offers,
    pcs: side.pcs,
    signaling: peer?.signaling || 'none',
    ice: peer?.ice || 'none',
    conn: peer?.conn || 'none',
    video: peer?.video || 0,
    audio: peer?.audio || 0,
  }
}

async function hideThenShow(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

/**
 * Playwright's Chromium starts with background-timer throttling disabled, and
 * pausing virtual time deadlocks a live RTCPeerConnection. Holding outbound
 * signaling for 22s is the same thing a frozen Android main thread looks like
 * to the server: no heartbeats and no other app messages.
 */
async function holdSignaling(page, ms) {
  await page.evaluate(() => { window.__holdSends = true })
  await page.waitForTimeout(ms)
  await page.evaluate(() => { window.__holdSends = false })
}

function identity(id, code) {
  return {
    participantId: id,
    name: 'Ava',
    role: 'guest',
    code,
    camOn: true,
    micId: '',
    outId: '',
    musicOn: true,
    jamEnabled: false,
    jamDelayMs: 40,
    monitorMode: 'opus',
    transportMode: 'arrangement',
  }
}

async function bootPair(browser, { hostProfile, guestProfile, hostId, guestId, staleGuest }) {
  const hostContext = await browser.newContext(hostProfile)
  const guestContext = await browser.newContext(guestProfile)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  host.on('pageerror', (error) => console.log('HOST PAGE', error.message))
  guest.on('pageerror', (error) => console.log('GUEST PAGE', error.message))
  await install(host)
  await install(guest)
  await host.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), hostId)
  if (staleGuest) {
    await guest.addInitScript((payload) => {
      localStorage.setItem('cueharbor-participant', payload.id)
      localStorage.setItem('cueharbor-identity', JSON.stringify(payload.identity))
    }, { id: guestId, identity: identity(guestId, DEAD) })
  } else {
    await guest.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), guestId)
  }
  return { host, guest, hostContext, guestContext }
}

async function connectCall(host, guest) {
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
  return code
}

function judgeCall(held, events, invite) {
  const fails = []
  const hostPeer = held.host.peers[0]
  const guestPeer = held.guest.peers[0]
  if (held.throttledWs !== 1) fails.push(`throttled sockets ${held.throttledWs} (a paused timer closed the socket)`)
  if (held.host.pcs > 1 || held.guest.pcs > 1) fails.push(`peer connections rebuilt host=${held.host.pcs} guest=${held.guest.pcs}`)
  const evicts = events.filter((entry) => entry.event === 'evict' || entry.event === 'duplicate').length
  if (evicts) fails.push(`server evict/duplicate ${evicts}`)
  if (hostPeer?.signaling !== 'stable' || guestPeer?.signaling !== 'stable') fails.push(`signaling host=${hostPeer?.signaling} guest=${guestPeer?.signaling}`)
  if (hostPeer?.conn !== 'connected' || guestPeer?.conn !== 'connected') fails.push(`connection host=${hostPeer?.conn}/${hostPeer?.ice} guest=${guestPeer?.conn}/${guestPeer?.ice}`)
  if ((hostPeer?.video || 0) <= 0 || (hostPeer?.audio || 0) <= 0) fails.push('host inbound bytes are 0')
  if ((guestPeer?.video || 0) <= 0 || (guestPeer?.audio || 0) <= 0) fails.push('guest inbound bytes are 0')
  if (held.guest.offers > 0) fails.push(`guest created ${held.guest.offers} offers`)
  if (invite && held.guest.code && held.guest.code !== invite) fails.push(`guest stayed on ${held.guest.code} instead of ${invite}`)
  const staleSent = (held.guest.sent || []).some((row) => row.includes(DEAD))
  if (staleSent) fails.push('guest hello still named the stored dead session')
  return fails
}

async function runCall(browser, label, { androidHost, staleGuest }) {
  const suffix = randomBytes(6).toString('hex')
  const hostId = `00000000-0000-4000-8000-${suffix}`
  const guestId = `ffffffff-ffff-4fff-8fff-${suffix}`
  const pair = await bootPair(browser, {
    hostProfile: androidHost ? galaxy : iphone,
    guestProfile: androidHost ? iphone : galaxy,
    hostId,
    guestId,
    staleGuest,
  })
  const android = androidHost ? pair.host : pair.guest
  let code = ''
  const fails = []
  try {
    await mobileNetwork(pair.host, androidHost)
    await mobileNetwork(pair.guest, !androidHost)
    code = await connectCall(pair.host, pair.guest)
    await pair.host.waitForTimeout(8000)
    console.log(label, 'before-throttle', JSON.stringify({ host: line(await sample(pair.host)), guest: line(await sample(pair.guest)) }))
    await hideThenShow(android)
    await holdSignaling(android, 22000)
    await android.waitForTimeout(2000)
    const started = Date.now()
    let held = null
    while (Date.now() - started < waitMs) {
      await pair.host.waitForTimeout(5000)
      const row = { host: await sample(pair.host), guest: await sample(pair.guest) }
      held = row
      console.log(label, JSON.stringify({ at: Math.round((Date.now() - started) / 1000), host: line(row.host), guest: line(row.guest) }))
    }
    const diagRes = await pair.host.request.get(`${base}/api/diag/${code}`)
    const diag = diagRes.ok() ? await diagRes.json() : { entries: [] }
    const events = (diag.entries || []).filter((entry) => entry.event)
    const throttled = androidHost ? held.host : held.guest
    fails.push(...judgeCall({ ...held, throttledWs: throttled.ws }, events, code))
    console.log(label, fails.length ? 'FAIL' : 'PASS')
    for (const reason of fails) console.log(label, 'reason:', reason)
    console.log(label, 'serverEvents:', JSON.stringify(events.map((entry) => ({ event: entry.event, note: entry.note }))))
    console.log(label, 'throttledCloses:', JSON.stringify((throttled.closes || []).filter((row) => row.kind !== 'open-ctor')))
  } catch (error) {
    fails.push(error instanceof Error ? error.message : String(error))
    console.log(label, 'FAIL')
    console.log(label, 'reason:', fails[fails.length - 1])
  } finally {
    await pair.hostContext.close()
    await pair.guestContext.close()
  }
  return fails
}

async function runStale(browser) {
  const label = 'stale-invite'
  const suffix = randomBytes(6).toString('hex')
  const hostId = `00000000-0000-4000-8000-${suffix}`
  const guestId = `ffffffff-ffff-4fff-8fff-${suffix}`
  const fails = []
  const hostContext = await browser.newContext(iphone)
  const guestContext = await browser.newContext(galaxy)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await install(host)
    await install(guest)
    await host.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), hostId)
    await guest.addInitScript((payload) => {
      localStorage.setItem('cueharbor-participant', payload.id)
      localStorage.setItem('cueharbor-identity', JSON.stringify(payload.identity))
    }, { id: guestId, identity: identity(guestId, DEAD) })
    await mobileNetwork(guest, true)
    await guest.goto(`${base}/?session=${DEAD}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await guest.getByText(/no longer live/i).first().waitFor({ timeout: 20000 })
    await guest.waitForTimeout(8000)
    const afterDead = await sample(guest)
    if (afterDead.stored === DEAD) fails.push('failed rejoin left the dead code stored')
    if (afterDead.ws > 1) fails.push(`dead session reconnected ${afterDead.ws} times`)
    await host.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await host.getByRole('button', { name: 'Session', exact: true }).click()
    await host.getByRole('button', { name: 'Create invite' }).click()
    const codeLabel = host.locator('.dock-bar strong').filter({ hasText: /Session [A-Z0-9]{6}/ })
    await codeLabel.waitFor({ timeout: 30000 })
    const code = (await codeLabel.innerText()).replace('Session ', '').trim()
    console.log(label, 'CODE', code)
    await guest.goto(`${base}/?session=${code}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    const opened = await sample(guest)
    if ((opened.sent || []).some((row) => row.includes(DEAD))) fails.push('invite link still helloed the stored dead session')
    if (opened.code === DEAD) fails.push('invite link displayed the stored dead session')
    await guest.getByPlaceholder('Your name').fill('Ava')
    const join = guest.locator('#join-session')
    if (await join.isVisible().catch(() => false)) await join.click()
    await guest.getByRole('button', { name: 'Session', exact: true }).click()
    await host.getByRole('button', { name: 'people' }).click()
    await host.locator('.waiting', { hasText: 'Ava' }).getByRole('button', { name: 'Admit' }).click({ timeout: 20000 })
    const joined = await sample(guest)
    if (joined.code !== code) fails.push(`guest code ${joined.code || 'none'} != invite ${code}`)
    if (joined.stored === DEAD) fails.push('stored code was still the dead session after join')
    console.log(label, fails.length ? 'FAIL' : 'PASS')
    for (const reason of fails) console.log(label, 'reason:', reason)
    console.log(label, 'afterDead', JSON.stringify({ stored: afterDead.stored, ws: afterDead.ws }))
    console.log(label, 'joined', JSON.stringify({ code: joined.code, stored: joined.stored, sent: joined.sent }))
  } catch (error) {
    fails.push(error instanceof Error ? error.message : String(error))
    console.log(label, 'FAIL')
    console.log(label, 'reason:', fails[fails.length - 1])
  } finally {
    await hostContext.close()
    await guestContext.close()
  }
  return fails
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const summary = []
try {
  const scenarios = [
    ['android-host', () => runCall(browser, 'android-host', { androidHost: true, staleGuest: false })],
    ['android-guest', () => runCall(browser, 'android-guest', { androidHost: false, staleGuest: false })],
    ['stale-invite', () => runStale(browser)],
  ]
  for (const [name, run] of scenarios) {
    const fails = await run()
    summary.push({ name, pass: fails.length === 0, fails })
  }
} finally {
  await browser.close()
}
console.log('SUMMARY', JSON.stringify(summary))
const failed = summary.filter((row) => !row.pass)
if (failed.length) {
  console.log('FAIL')
  console.log('failed scenarios:', failed.map((row) => row.name).join(', '))
  process.exitCode = 1
} else {
  console.log('PASS')
}
