/**
 * Two-phone call against a running CueHarbor.
 *
 *   node scripts/prod-call-test.mjs https://cueharbor.onrender.com
 *
 * Five runs, all under a mobile network (150 ms RTT, 1% loss, 4G cap):
 *   1. Android host, iPhone guest, 6x CPU and paused timers on the Android
 *   2. Android guest, iPhone host, same throttle on the Android
 *   3. Guest localStorage still holds a dead session code and opens a fresh invite
 *   4. Cellular: the host signaling socket is cut every 8s for 60s, and the
 *      host network drops for 1.5s once. Media bytes must keep flowing or
 *      recover within 5s. Set SCENARIO=cellular to run only that one.
 *   5. Uplink: the host is on one shared ~1 Mbps pipe with 150 ms delay, and
 *      its saved project carries a ~1 MB audio asset. The host signaling
 *      socket is cut about every 8s. After the first frames, every 4s of
 *      the next minute must stay at or above ~10 fps. Set SCENARIO=uplink
 *      to run only that one.
 *   6. Carrier: direct UDP is dropped and TURN UDP is held for 12s, so a
 *      stack that gathers TCP nominates it. Remote TCP is then reset for
 *      4s and again every 12s, while UDP still works after the hold. Guest
 *      video must not stall more than ~3s and must average at least 12 fps
 *      across 90s (the headless encoder spends its first ~45s near 11 fps).
 *      Set SCENARIO=carrier to run only that one.
 *      Devtools throttling caps each connection on its own, so it does not
 *      starve video when a WebSocket is busy. The host browser is paced by
 *      scripts/uplink-pace.c instead, one bucket for every socket.
 *   7. Trickle: the host socket is killed as the guest's answer arrives.
 *      Candidates are removed from the offer and the answer, and trickle on
 *      that host socket is dropped, which is the same-machine shape of a
 *      pair whose answer carried no usable candidates. Both directions of
 *      video must flow within 15s. Set SCENARIO=trickle to run only that one.
 *
 * The Android tab is hidden and shown. Then its outbound signaling is held
 * for 22s, which is what a frozen main thread looks like to the server.
 * Prints PASS or FAIL per scenario. A live socket must stay up through that
 * hold, and the invite code must win over the stored one.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const sockets = window.__sockets || (window.__sockets = [])
    sockets.push(sock)
    const mark = (kind, extra) => {
      const row = window.__wsLog || (window.__wsLog = [])
      row.push({ t: Math.round(performance.now()), kind, ready: sock.readyState, ...extra })
    }
    mark('open-ctor', { url: String(url) })
    const orig = sock.send.bind(sock)
    sock.send = (data) => {
      let outgoing = data
      let text = String(data)
      const stripOffer = window.__dropHostCandidates && text.includes('"type":"offer"')
      const stripAnswer = window.__stripAnswerCandidates && text.includes('"type":"answer"')
      if (stripOffer || stripAnswer) {
        try {
          const msg = JSON.parse(text)
          const sdp = msg?.data?.description?.sdp
          if (typeof sdp === 'string') {
            const lines = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
              .filter((line) => line && !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates')
            msg.data.description.sdp = `${lines.join('\r\n')}\r\n`
            outgoing = JSON.stringify(msg)
            text = outgoing
            if (stripAnswer) window.__strippedAnswers = (window.__strippedAnswers || 0) + 1
            else window.__strippedOffers = (window.__strippedOffers || 0) + 1
          }
        } catch {
          /* keep the original description */
        }
      }
      if (window.__dropHostCandidates && text.includes('"candidate"')) {
        window.__droppedCandidates = (window.__droppedCandidates || 0) + 1
        return
      }
      const sent = window.__sent || (window.__sent = [])
      if (sent.length < 40) sent.push(text.slice(0, 160))
      if (text.length >= 64 * 1024) {
        const big = window.__bigSends || (window.__bigSends = [])
        big.push(text.length)
      }
      if (window.__holdSends) return
      if (window.__failOffers && text.includes('"type":"offer"')) {
        window.__failOffers = false
        throw new Error('carrier reset')
      }
      return orig(outgoing)
    }
    let dropCandidates = false
    const shouldDrop = (event) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text.includes('"type":"answer"') && window.__dropHostCandidates) {
        window.__dropHostCandidates = false
        dropCandidates = true
        window.__answerSeen = (window.__answerSeen || 0) + 1
        setTimeout(() => {
          try { sock.close() } catch { /* already closing */ }
        }, 0)
        return false
      }
      return (dropCandidates || window.__dropHostCandidates) && text.includes('"candidate"')
    }
    let userOnMessage = null
    Object.defineProperty(sock, 'onmessage', {
      configurable: true,
      enumerable: true,
      get() { return userOnMessage },
      set(fn) { userOnMessage = typeof fn === 'function' ? fn : null },
    })
    sock.addEventListener('message', (event) => {
      if (shouldDrop(event)) return
      if (userOnMessage) userOnMessage.call(sock, event)
    })
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

  const origFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const body = init && typeof init.body === 'string' ? init.body : ''
      if (String(url).includes('/api/assets') && body) window.__assetPosts = (window.__assetPosts || 0) + body.length
    } catch {
      /* counting must not block the request */
    }
    return origFetch(input, init)
  }
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
        setInterval(draw, 66)
        const stream = canvas.captureStream?.(15)
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
      let frames = 0
      let path = ''
      try {
        const report = await pc.getStats()
        report.forEach((row) => {
          if (row.type === 'inbound-rtp' && row.kind === 'video') {
            video += row.bytesReceived || 0
            frames += row.framesDecoded || 0
          }
          if (row.type === 'inbound-rtp' && row.kind === 'audio') audio += row.bytesReceived || 0
          if (row.type === 'candidate-pair' && row.state === 'succeeded' && (row.nominated || row.selected) && row.localCandidateId) {
            const local = report.get(row.localCandidateId)
            const remote = row.remoteCandidateId ? report.get(row.remoteCandidateId) : null
            path = `${local?.candidateType || '?'}/${local?.protocol || '?'}/${local?.relayProtocol || '-'}->${remote?.candidateType || '?'}/${remote?.relayProtocol || '-'}`
          }
        })
      } catch {
        /* closed */
      }
      peers.push({
        signaling: pc.signalingState,
        ice: pc.iceConnectionState,
        conn: pc.connectionState,
        gather: pc.iceGatheringState,
        relay: / typ relay/.test(pc.localDescription?.sdp || ''),
        video,
        audio,
        frames,
        path,
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
      live: (window.__pcs || []).filter((pc) => pc.connectionState !== 'closed').length,
      big: (window.__bigSends || []).reduce((sum, n) => sum + n, 0),
      assets: window.__assetPosts || 0,
      sfu: Boolean(window.__cueharborSfu),
      playhead: window.__cueharborPlayhead || 0,
      transport: window.__cueharborStatus || '',
      rate: window.__cueharborRate || 48000,
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

async function connectCall(host, guest, options = {}) {
  await host.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: options.timeout || 45000 })
  if (options.project) {
    await host.waitForFunction((name) => document.querySelector('.project-name')?.value === name, options.project, { timeout: 30000 })
  }
  if (options.beforeInvite) await options.beforeInvite()
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
  const admit = host.locator('.waiting', { hasText: 'Ava' }).getByRole('button', { name: 'Admit' }).click({ timeout: options.admitTimeout || 20000 })
  if (options.duringAdmit) await options.duringAdmit()
  await admit
  if (!options.duringAdmit) await host.getByRole('button', { name: 'Session', exact: true }).click()
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
  if (!held.guest.sfu && held.guest.offers > 0) fails.push(`guest created ${held.guest.offers} offers`)
  if (invite && held.guest.code && held.guest.code !== invite) fails.push(`guest stayed on ${held.guest.code} instead of ${invite}`)
  const staleSent = (held.guest.sent || []).some((row) => row.includes(DEAD))
  if (staleSent) fails.push('guest hello still named the stored dead session')
  return fails
}

/** Host play must move the guest playhead to the same musical position, within 100 ms. */
async function assertPlaySync(host, guest) {
  const fails = []
  const play = host.locator('button.t-btn.play')
  if (!(await play.isVisible().catch(() => false))) {
    fails.push('host play button was not visible')
    return fails
  }
  await play.scrollIntoViewIfNeeded()
  await play.click()
  await host.waitForTimeout(1200)
  const hostRow = await videoBytes(host)
  const guestRow = await videoBytes(guest)
  const rate = hostRow.rate || 48000
  const gapMs = Math.abs(hostRow.playhead - guestRow.playhead) / rate * 1000
  console.log('play-sync', JSON.stringify({
    host: hostRow.playhead,
    guest: guestRow.playhead,
    hostStatus: hostRow.transport,
    guestStatus: guestRow.transport,
    gapMs: Math.round(gapMs),
  }))
  if (hostRow.transport !== 'playing') fails.push(`host transport is ${hostRow.transport || 'stopped'}`)
  if (guestRow.transport !== 'playing') fails.push(`guest transport is ${guestRow.transport || 'stopped'}`)
  if (gapMs > 100) fails.push(`guest playhead is ${Math.round(gapMs)} ms from the host`)
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
    fails.push(...(await assertPlaySync(pair.host, pair.guest)))
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

async function cutSocket(page) {
  return page.evaluate(() => {
    const open = (window.__sockets || []).filter((sock) => sock.readyState === WebSocket.OPEN && sock.url.includes('/ws'))
    for (const sock of open) sock.close()
    return open.length
  })
}

/**
 * The next offer send throws, which is a cellular reset eating the packet.
 * Main drops it. The fix queues it, then the socket reconnect flushes it.
 */
async function cutSocketAndRestart(page) {
  await page.evaluate(() => { window.__failOffers = true })
  const restarted = await page.evaluate(() => {
    const pc = (window.__pcs || []).find((item) => item.connectionState !== 'closed' && item.signalingState === 'stable')
    if (pc) pc.restartIce()
    return Boolean(pc)
  })
  const deadline = Date.now() + 2000
  let signaling = 'none'
  while (Date.now() < deadline) {
    signaling = (await videoBytes(page)).signaling
    if (signaling === 'have-local-offer') break
    await page.waitForTimeout(100)
  }
  await page.evaluate(() => { window.__failOffers = false })
  const closed = await cutSocket(page)
  return { restarted, signaling, closed }
}

async function videoBytes(page) {
  const row = await sample(page)
  const peer = [...(row.peers || [])].sort((a, b) => (b.video || 0) - (a.video || 0))[0] || row.peers[0]
  return {
    video: peer?.video || 0,
    frames: peer?.frames || 0,
    audio: peer?.audio || 0,
    live: row.live || 0,
    conn: peer?.conn || 'none',
    signaling: peer?.signaling || 'none',
    offers: row.offers || 0,
    path: peer?.path || '',
    sfu: row.sfu,
    playhead: row.playhead || 0,
    transport: row.transport || '',
    rate: row.rate || 48000,
  }
}

/** Bytes must move forward within the budget. A socket cut must not build a second peer connection. */
async function expectMedia(host, guest, before, ms, { allowRebuild }) {
  const deadline = Date.now() + ms
  let hostNow = before.host
  let guestNow = before.guest
  let hostLive = before.hostLive
  let guestLive = before.guestLive
  while (Date.now() < deadline) {
    await host.waitForTimeout(500)
    const h = await videoBytes(host)
    const g = await videoBytes(guest)
    hostNow = h.video
    guestNow = g.video
    hostLive = h.live
    guestLive = g.live
    if (h.video > before.host && g.video > before.guest) {
      const rebuilt = !allowRebuild && (h.live !== 1 || g.live !== 1)
      return { ok: !rebuilt, hostNow: h.video, guestNow: g.video, hostLive: h.live, guestLive: g.live, rebuilt }
    }
  }
  const rebuilt = !allowRebuild && (hostLive !== 1 || guestLive !== 1)
  return { ok: false, hostNow, guestNow, hostLive, guestLive, rebuilt }
}

/**
 * Carrier path: the host's signaling socket dies about every 8s for a minute,
 * and the network drops for 1.5s once. Inbound video has to keep climbing,
 * or be climbing again within 5s of the network returning.
 */
/**
 * The host socket dies as the guest answer lands, while candidates are still
 * trickling. Old builds drop those candidates and never restart ICE `new`.
 * Video has to flow both ways within 15s of the answer.
 */
async function runTrickle(browser) {
  const label = 'trickle'
  const suffix = randomBytes(6).toString('hex')
  const hostId = `00000000-0000-4000-8000-${suffix}`
  const guestId = `ffffffff-ffff-4fff-8fff-${suffix}`
  const pair = await bootPair(browser, {
    hostProfile: galaxy,
    guestProfile: iphone,
    hostId,
    guestId,
    staleGuest: false,
  })
  const fails = []
  try {
    await pair.host.addInitScript(() => { window.__dropHostCandidates = true })
    await pair.guest.addInitScript(() => { window.__stripAnswerCandidates = true })
    const code = await connectCall(pair.host, pair.guest)
    const armed = Date.now()
    let seen = 0
    while (Date.now() - armed < 20000) {
      seen = await pair.host.evaluate(() => window.__answerSeen || 0)
      if (seen) break
      await pair.host.waitForTimeout(100)
    }
    const sfu = await pair.host.evaluate(() => Boolean(window.__cueharborSfu))
    if (!seen && !sfu) fails.push('guest answer did not arrive')
    const deadline = Date.now() + 15000
    let hostVideo = 0
    let guestVideo = 0
    let hostIce = 'none'
    let guestIce = 'none'
    while (Date.now() < deadline) {
      const host = await videoBytes(pair.host)
      const guest = await videoBytes(pair.guest)
      hostVideo = host.video
      guestVideo = guest.video
      hostIce = host.conn
      guestIce = guest.conn
      console.log(label, 'video', JSON.stringify({ code, host: host.video, guest: guest.video, hostIce: host.conn, guestIce: guest.conn }))
      if (host.video > 0 && guest.video > 0) break
      await pair.host.waitForTimeout(500)
    }
    const marks = {
      stripped: await pair.guest.evaluate(() => window.__strippedAnswers || 0),
      offers: await pair.host.evaluate(() => window.__strippedOffers || 0),
      dropped: await pair.host.evaluate(() => window.__droppedCandidates || 0),
    }
    console.log(label, 'result', JSON.stringify({ code, seen, ...marks, hostVideo, guestVideo, hostIce, guestIce }))
    if (seen && (hostVideo <= 0 || guestVideo <= 0)) {
      fails.push(`media did not flow both ways within 15s host=${hostVideo} guest=${guestVideo} ice=${hostIce}/${guestIce}`)
    }
    console.log(label, fails.length ? 'FAIL' : 'PASS')
    for (const reason of fails) console.log(label, 'reason:', reason)
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

async function runCellular(browser) {
  const label = 'cellular'
  const suffix = randomBytes(6).toString('hex')
  const hostId = `00000000-0000-4000-8000-${suffix}`
  const guestId = `ffffffff-ffff-4fff-8fff-${suffix}`
  const pair = await bootPair(browser, {
    hostProfile: galaxy,
    guestProfile: iphone,
    hostId,
    guestId,
    staleGuest: false,
  })
  const fails = []
  let blipped = false
  try {
    const hostCdp = await mobileNetwork(pair.host, false)
    await mobileNetwork(pair.guest, false)
    await connectCall(pair.host, pair.guest)
    const readyAt = Date.now()
    let ready = null
    while (Date.now() - readyAt < 25000) {
      const host = await videoBytes(pair.host)
      const guest = await videoBytes(pair.guest)
      if (host.video > 0 && guest.video > 0 && host.conn === 'connected' && guest.conn === 'connected') {
        ready = { host, guest }
        break
      }
      await pair.host.waitForTimeout(500)
    }
    if (!ready) {
      const host = await videoBytes(pair.host)
      const guest = await videoBytes(pair.guest)
      fails.push(`call did not connect host=${host.conn}/${host.video} guest=${guest.conn}/${guest.video}`)
    } else {
      console.log(label, 'connected', JSON.stringify(ready))
      const sfu = ready.host.sfu || ready.guest.sfu
      const beforeRestart = { host: ready.host.video, guest: ready.guest.video, hostLive: ready.host.live, guestLive: ready.guest.live }
      if (sfu) {
        console.log(label, 'sfu', 'media is on the SFU, so a mesh ICE restart is not part of this call')
      } else {
      const restarted = await cutSocketAndRestart(pair.host)
      console.log(label, 'restart-while-down', JSON.stringify(restarted))
      const answeredBy = Date.now() + 5000
      let hostSig = restarted.signaling
      let guestSig = 'none'
      while (Date.now() < answeredBy) {
        hostSig = (await videoBytes(pair.host)).signaling
        guestSig = (await videoBytes(pair.guest)).signaling
        if (hostSig === 'stable') break
        await pair.host.waitForTimeout(300)
      }
      const afterRestart = await videoBytes(pair.host)
      const guestAfter = await videoBytes(pair.guest)
      console.log(label, 'restart-recovered', JSON.stringify({ hostSig, guestSig, host: afterRestart.video, guest: guestAfter.video, live: afterRestart.live }))
      if (!restarted.restarted || restarted.signaling !== 'have-local-offer') fails.push(`ICE restart did not produce an offer (${restarted.signaling})`)
      if (hostSig !== 'stable') fails.push(`ICE restart offer was not answered host=${hostSig} guest=${guestSig}`)
      if (afterRestart.live !== 1 || guestAfter.live !== 1) fails.push(`ICE restart rebuilt peer connections host=${afterRestart.live} guest=${guestAfter.live}`)
      if (afterRestart.video <= beforeRestart.host || guestAfter.video <= beforeRestart.guest) {
        fails.push(`media stalled across the ICE restart host ${beforeRestart.host}->${afterRestart.video} guest ${beforeRestart.guest}->${guestAfter.video}`)
      }
      }
      const frameStartHost = (await videoBytes(pair.host)).frames
      const frameStartGuest = (await videoBytes(pair.guest)).frames
      const end = Date.now() + 60000
      let nextCut = Date.now() + 8000
      const blipAt = Date.now() + 20000
      while (Date.now() < end) {
        if (Date.now() < nextCut) {
          await pair.host.waitForTimeout(400)
          continue
        }
        const beforeHost = await videoBytes(pair.host)
        const beforeGuest = await videoBytes(pair.guest)
        const closed = await cutSocket(pair.host)
        if (!closed) fails.push('host socket was already closed')
        let allowRebuild = false
        if (!blipped && Date.now() >= blipAt) {
          blipped = true
          allowRebuild = true
          await hostCdp.send('Network.emulateNetworkConditions', {
            offline: true,
            latency: 0,
            downloadThroughput: 0,
            uploadThroughput: 0,
          })
          await pair.host.waitForTimeout(1500)
          await hostCdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 150,
            downloadThroughput: 500_000,
            uploadThroughput: 250_000,
            packetLoss: 1,
          })
        }
        const grew = await expectMedia(
          pair.host,
          pair.guest,
          { host: beforeHost.video, guest: beforeGuest.video, hostLive: beforeHost.live, guestLive: beforeGuest.live },
          5000,
          { allowRebuild },
        )
        console.log(label, 'cut', JSON.stringify({ closed, blipped, allowRebuild, grew }))
        if (grew.rebuilt) fails.push(`socket cut rebuilt peer connections host=${grew.hostLive} guest=${grew.guestLive}`)
        else if (!grew.ok) fails.push(`media stalled host ${beforeHost.video}->${grew.hostNow} guest ${beforeGuest.video}->${grew.guestNow} live=${grew.hostLive}/${grew.guestLive}`)
        nextCut = Date.now() + 8000
      }
      const hostEnd = await videoBytes(pair.host)
      const guestEnd = await videoBytes(pair.guest)
      console.log(label, 'frames', JSON.stringify({ host: [frameStartHost, hostEnd.frames], guest: [frameStartGuest, guestEnd.frames] }))
      if (hostEnd.frames <= frameStartHost) fails.push(`host video frames did not increase for 60s (${frameStartHost}->${hostEnd.frames})`)
      if (guestEnd.frames <= frameStartGuest) fails.push(`guest video frames did not increase for 60s (${frameStartGuest}->${guestEnd.frames})`)
      if (!blipped) fails.push('the network blip did not run')
    }
    console.log(label, fails.length ? 'FAIL' : 'PASS')
    for (const reason of fails) console.log(label, 'reason:', reason)
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

const UPLINK_PCM_BYTES = 750_000

/** A saved project whose clip references a ~1 MB wav, so the live app syncs it on admit. */
function seedBulkProject(pcmBytes) {
  const dataSize = pcmBytes
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 48000, true)
  view.setUint32(28, 96000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, dataSize, true)
  const wav = new Blob([buffer], { type: 'audio/wav' })
  const project = {
    version: 1,
    id: 'prj_uplink',
    name: 'Uplink',
    sampleRate: 48000,
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [
      {
        id: 'trk_vocal', name: 'Vocal', type: 'audio', color: '#ef6b6b', volume: 0.8, pan: 0,
        mute: false, solo: false, armed: true, monitor: false, input: 'mic', inserts: [], clips: [], midiClips: [],
      },
      {
        id: 'trk_music', name: 'Music', type: 'audio', color: '#73c48f', volume: 0.8, pan: 0,
        mute: false, solo: false, armed: false, monitor: false, input: 'none', inserts: [],
        clips: [{
          id: 'clip_uplink', name: 'Bulk', bufferId: 'buf_uplink', startSample: 0, offsetSamples: 0,
          durationSamples: dataSize / 2, fadeInSamples: 0, fadeOutSamples: 0, gain: 0.9, source: 'import',
        }],
        midiClips: [],
      },
      {
        id: 'trk_keys', name: 'Keys', type: 'midi', color: '#79b8d4', volume: 0.8, pan: 0,
        mute: false, solo: false, armed: false, monitor: false, input: 'none', inserts: [], clips: [], midiClips: [],
      },
    ],
    masterVolume: 0.9,
    masterInserts: [],
    loopEnabled: false,
    loopStartSample: 0,
    loopEndSample: 48000 * 8,
    metronomeEnabled: false,
    countIn: false,
    snap: true,
  }
  const record = {
    id: project.id,
    name: project.name,
    savedAt: Date.now(),
    project,
    workspace: { view: 'arrange', transportMode: 'arrangement', positionSamples: 0, selectedTrackId: 'trk_vocal', surface: 'studio', phonePane: 'edit' },
    assets: [{ id: 'buf_uplink', name: 'Bulk', sampleRate: 48000, wav }],
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cueharbor', 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['projects', 'meta'], 'readwrite')
      tx.objectStore('projects').put(record)
      tx.objectStore('meta').put(project.id, 'last')
      tx.oncomplete = () => {
        db.close()
        resolve(true)
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/**
 * Host on a shared 1 Mbps uplink with 150 ms delay, syncing a ~1 MB project
 * asset. The guest must receive host video the whole minute.
 */
async function runUplink(browser) {
  const label = 'uplink'
  const fails = []
  const dir = mkdtempSync(path.join(tmpdir(), 'cueharbor-uplink-'))
  const so = path.join(dir, 'libuplink.so')
  const shm = path.join(dir, 'bucket')
  const arm = path.join(dir, 'arm')
  let hostBrowser = null
  let guestBrowser = null
  try {
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'uplink-pace.c')
    execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', so, source, '-ldl', '-lpthread'], { stdio: 'inherit' })
    const mediaArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
    hostBrowser = await chromium.launch({
      env: { ...process.env, LD_PRELOAD: so, UPLINK_BPS: '125000', UPLINK_LATENCY_MS: '150', UPLINK_SHM: shm, UPLINK_ARM: arm },
      args: mediaArgs,
    })
    guestBrowser = browser
    const suffix = randomBytes(6).toString('hex')
    const hostId = `00000000-0000-4000-8000-${suffix}`
    const guestId = `ffffffff-ffff-4fff-8fff-${suffix}`
    const hostContext = await hostBrowser.newContext(galaxy)
    const guestContext = await guestBrowser.newContext(iphone)
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    host.on('pageerror', (error) => console.log('HOST PAGE', error.message))
    guest.on('pageerror', (error) => console.log('GUEST PAGE', error.message))
    try {
      await install(host)
      await install(guest)
      await host.addInitScript(seedBulkProject, UPLINK_PCM_BYTES)
      await host.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), hostId)
      await guest.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), guestId)
      const cdp = await host.context().newCDPSession(host)
      await cdp.send('Network.enable')
      // Devtools throughput is per connection, so it cannot make a WebSocket
      // upload and RTP share one radio. The pacer above is that shared 1 Mbps
      // pipe. This adds the cellular delay on the host.
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: -1,
        uploadThroughput: -1,
        packetLoss: 0,
      })
      await connectCall(host, guest, {
        project: 'Uplink',
        timeout: 90000,
        admitTimeout: 90000,
        beforeInvite: async () => writeFileSync(arm, '1'),
        duringAdmit: async () => {
          const started = Date.now()
          let firstAt = 0
          let nextCut = started + 8000
          let windowStart = null
          let lastLog = started
          let scored = 0
          let worst = null
          let framesAtStart = 0
          let lastFrames = 0
          while (!firstAt || Date.now() - firstAt < 60000) {
            if (Date.now() - started >= 90000) break
            await guest.waitForTimeout(2000)
            if (firstAt && Date.now() >= nextCut) {
              nextCut = Date.now() + 8000
              void cutSocket(host).then((closed) => {
                console.log(label, 'cut', JSON.stringify({ closed, t: Math.round((Date.now() - started) / 1000) }))
              })
            }
            const row = await videoBytes(guest)
            const t = Date.now()
            if (row.frames > 0 && !firstAt) {
              firstAt = t
              framesAtStart = row.frames
            }
            lastFrames = row.frames
            if (firstAt && !windowStart && t - firstAt >= 8000) windowStart = { t, frames: row.frames }
            const elapsed = windowStart ? t - windowStart.t : 0
            const fps = windowStart && elapsed >= 4000 ? ((row.frames - windowStart.frames) * 1000) / elapsed : null
            console.log(label, 'video', JSON.stringify({
              t: Math.round((t - started) / 1000),
              dt: Math.round((t - lastLog) / 1000),
              video: row.video,
              frames: row.frames,
              fps: fps == null ? null : Math.round(fps * 10) / 10,
              conn: row.conn,
            }))
            lastLog = t
            if (!firstAt && t - started >= 15000) {
              fails.push('host video did not reach the guest within 15s of admit')
              return
            }
            if (fps != null) {
              if (elapsed > 8000) {
                fails.push(`fps sample gap was ${Math.round(elapsed / 1000)}s, so the rate is not a 4s window`)
                return
              }
              scored += 1
              if (!worst || fps < worst.fps) worst = { fps, elapsed }
              windowStart = { t, frames: row.frames }
            }
          }
          const span = firstAt ? (Date.now() - firstAt) / 1000 : 0
          const average = span > 0 ? (lastFrames - framesAtStart) / span : 0
          console.log(label, 'fps-summary', JSON.stringify({
            scored,
            worst: worst ? Math.round(worst.fps * 10) / 10 : null,
            average: Math.round(average * 10) / 10,
          }))
          if (scored < 8) fails.push(`only ${scored} fps windows in the minute`)
          // Live main (3236df8) fell to 6.7 fps over a 4s window on this pipe.
          // The minute has to average about 10 fps, and no window may fall under 8.
          if (!worst || worst.fps < 8 || average < 10) {
            fails.push(`guest video worst ${worst ? worst.fps.toFixed(1) : '0'} fps over ${worst ? Math.round(worst.elapsed / 1000) : 0}s, average ${average.toFixed(1)} fps (need ~10 fps sustained)`)
          }
          if (firstAt && Date.now() - firstAt < 55000) {
            fails.push(`guest video was not observed for 60s (ran ${Math.round((Date.now() - firstAt) / 1000)}s)`)
          }
        },
      })
      const done = await sample(host)
      const moved = Math.max(done.big, done.assets)
      console.log(label, 'asset', JSON.stringify({ big: done.big, assets: done.assets }))
      if (moved < 500_000) fails.push(`project asset did not sync (ws ${done.big}, http ${done.assets})`)
      console.log(label, fails.length ? 'FAIL' : 'PASS')
      for (const reason of fails) console.log(label, 'reason:', reason)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  } catch (error) {
    fails.push(error instanceof Error ? error.message : String(error))
    console.log(label, 'FAIL')
    console.log(label, 'reason:', fails[fails.length - 1])
  } finally {
    if (hostBrowser) await hostBrowser.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return fails
}

/**
 * The carrier resets every TCP flow and leaves UDP up. A stack that nominated
 * TURN-over-TCP freezes for the whole reset. UDP media should not.
 */
async function runCarrier(browser) {
  const label = 'carrier'
  const fails = []
  const dir = mkdtempSync(path.join(tmpdir(), 'cueharbor-carrier-'))
  const so = path.join(dir, 'libuplink.so')
  const shm = path.join(dir, 'bucket')
  const arm = path.join(dir, 'arm')
  let hostBrowser = null
  let guestBrowser = null
  try {
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'uplink-pace.c')
    execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', so, source, '-ldl', '-lpthread'], { stdio: 'inherit' })
    const mediaArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
    hostBrowser = await chromium.launch({
      env: {
        ...process.env,
        LD_PRELOAD: so,
        UPLINK_BPS: '50000000',
        UPLINK_LATENCY_MS: '0',
        UPLINK_SHM: shm,
        UPLINK_ARM: arm,
        UPLINK_RELAY_UDP: '1',
        UPLINK_UDP_HOLD_MS: '12000',
        UPLINK_TCP_DOWN_START_MS: '8000',
        UPLINK_TCP_DOWN_END_MS: '12000',
        UPLINK_TCP_KILL_EVERY_MS: '12000',
      },
      args: mediaArgs,
    })
    guestBrowser = browser
    const suffix = randomBytes(6).toString('hex')
    const hostId = `00000000-0000-4000-8000-${suffix}`
    const guestId = `ffffffff-ffff-4fff-8fff-${suffix}`
    const hostContext = await hostBrowser.newContext(galaxy)
    const guestContext = await guestBrowser.newContext(iphone)
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    host.on('pageerror', (error) => console.log('HOST PAGE', error.message))
    guest.on('pageerror', (error) => console.log('GUEST PAGE', error.message))
    const admitMark = { at: 0 }
    host.on('console', (msg) => {
      const text = msg.text()
      if (/sfu|media server|ice|turn|Reconnecting/i.test(text)) console.log('HOST LOG', text.slice(0, 300))
    })
    host.on('response', (response) => {
      const url = response.url()
      if (!url.includes('/api/sfu/')) return
      const elapsed = admitMark.at ? Math.round((Date.now() - admitMark.at) / 1000) : 0
      console.log('HOST SFU', response.status(), url.replace(base, ''), 't', elapsed)
    })
    try {
      await install(host)
      await install(guest)
      await host.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), hostId)
      await guest.addInitScript((id) => localStorage.setItem('cueharbor-participant', id), guestId)
      await connectCall(host, guest, {
        timeout: 90000,
        admitTimeout: 90000,
        duringAdmit: async () => {
          admitMark.at = Date.now()
          writeFileSync(arm, '1')
          const started = Date.now()
          let firstAt = 0
          let lastFrames = 0
          let lastAdvance = 0
          let framesAtStart = 0
          let maxStall = 0
          let lastLog = started
          let hostFirst = 0
          let hostLast = 0
          let hostAdvance = 0
          let hostStall = 0
          while (!firstAt || Date.now() - firstAt < 90000) {
            if (Date.now() - started >= 130000) break
            await guest.waitForTimeout(1000)
            const row = await videoBytes(guest)
            const hostRow = await videoBytes(host)
            const hostAll = await sample(host)
            const t = Date.now()
            if (hostRow.frames > hostLast) {
              if (!hostFirst) hostFirst = t
              hostLast = hostRow.frames
              hostAdvance = t
            } else if (hostFirst && hostAdvance) {
              hostStall = Math.max(hostStall, t - hostAdvance)
            }
            if (row.frames > lastFrames) {
              if (!firstAt) {
                firstAt = t
                framesAtStart = row.frames
              }
              lastFrames = row.frames
              lastAdvance = t
            } else if (firstAt && lastAdvance) {
              maxStall = Math.max(maxStall, t - lastAdvance)
            }
            console.log(label, 'video', JSON.stringify({
              t: Math.round((t - started) / 1000),
              dt: Math.round((t - lastLog) / 1000),
              frames: row.frames,
              conn: row.conn,
              path: row.path,
              hostFrames: hostRow.frames,
              hostConn: hostRow.conn,
              hostPath: hostRow.path,
              hostPeers: hostAll.peers.map((peer) => `${peer.conn}/${peer.ice}/${peer.signaling}/${peer.gather}/${peer.relay ? 'relay' : 'norel'}`),
              stall: Math.round(maxStall / 100) / 10,
            }))
            lastLog = t
            if (!firstAt && t - started >= 30000) {
              fails.push('host video did not reach the guest within 30s of admit')
              return
            }
          }
          const span = firstAt ? (Date.now() - firstAt) / 1000 : 0
          const average = span > 0 ? (lastFrames - framesAtStart) / span : 0
          console.log(label, 'summary', JSON.stringify({
            span: Math.round(span),
            stall: Math.round(maxStall / 100) / 10,
            average: Math.round(average * 10) / 10,
            frames: lastFrames,
          }))
          if (maxStall > 3500) fails.push(`guest video stalled ${Math.round(maxStall / 100) / 10}s (need under ~3s)`)
          if (average < 12) fails.push(`guest video averaged ${average.toFixed(1)} fps (need at least 12)`)
          if (firstAt && Date.now() - firstAt < 85000) fails.push(`guest video was not observed for 90s (ran ${Math.round((Date.now() - firstAt) / 1000)}s)`)
          const hostSpan = hostFirst ? (Date.now() - hostFirst) / 1000 : 0
          console.log(label, 'host-frames', JSON.stringify({ frames: hostLast, stall: Math.round(hostStall / 100) / 10, span: Math.round(hostSpan) }))
          if (hostLast <= 0 || hostSpan < 60) fails.push(`host video frames did not keep increasing for 60s (frames ${hostLast}, span ${Math.round(hostSpan)}s)`)
          if (hostStall > 3500) fails.push(`host video stalled ${Math.round(hostStall / 100) / 10}s (need under ~3s)`)
        },
      })
      console.log(label, fails.length ? 'FAIL' : 'PASS')
      for (const reason of fails) console.log(label, 'reason:', reason)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  } catch (error) {
    fails.push(error instanceof Error ? error.message : String(error))
    console.log(label, 'FAIL')
    console.log(label, 'reason:', fails[fails.length - 1])
  } finally {
    if (hostBrowser) await hostBrowser.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return fails
}

async function runUsage() {
  const fails = []
  const response = await fetch(`${base}/api/usage`)
  const text = await response.text()
  console.log('usage', response.status, text.slice(0, 500))
  if (!response.ok) fails.push(`GET /api/usage returned ${response.status}`)
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    fails.push('GET /api/usage was not JSON')
  }
  if (!/^\d{4}-\d{2}$/.test(body.month || '')) fails.push('usage month missing')
  if (typeof body.bytes !== 'number') fails.push('usage bytes missing')
  if (typeof body.gigabytes !== 'number') fails.push('usage gigabytes missing')
  if (typeof body.capGigabytes !== 'number') fails.push('usage cap missing')
  if (typeof body.blocked !== 'boolean') fails.push('usage blocked missing')
  if (/secret|token|credential|authorization/i.test(text)) fails.push('usage response included a secret')
  console.log('usage', fails.length ? 'FAIL' : 'PASS')
  for (const reason of fails) console.log('usage', 'reason:', reason)
  return fails
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const summary = []
try {
  const scenarios = [
    ['usage', () => runUsage()],
    ['android-host', () => runCall(browser, 'android-host', { androidHost: true, staleGuest: false })],
    ['android-guest', () => runCall(browser, 'android-guest', { androidHost: false, staleGuest: false })],
    ['stale-invite', () => runStale(browser)],
    ['cellular', () => runCellular(browser)],
    ['uplink', () => runUplink(browser)],
    ['carrier', () => runCarrier(browser)],
    ['trickle', () => runTrickle(browser)],
  ]
  const only = process.env.SCENARIO || ''
  const selected = only ? scenarios.filter(([name]) => name === only) : scenarios
  if (!selected.length) {
    console.log('FAIL')
    console.log('reason: unknown SCENARIO', only)
    summary.push({ name: only || 'scenario', pass: false, fails: ['unknown scenario'] })
  }
  for (const [name, run] of selected) {
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
