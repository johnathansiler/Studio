import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { decodeWavPCM } from '../model/wav'
import { capGigabytes } from '../model/usage'
import { bytesToArrayBuffer } from '../remote/hqTake'
import {
  ASSET_CHUNK_BYTES,
  ASSET_CHUNKS_PER_TURN,
  AssetExchange,
  assembleAssetWav,
  assetBytesAllowed,
  assetRelayCredit,
  assetStatusLabel,
  chooseAssetPath,
  encodeLosslessWav,
  memoryAssetStore,
  missingChunkIndexes,
  offersFromSignal,
  hashWav,
  packAssetChunk,
  parseAssetControl,
  pickAssetPeer,
  readAssetChunk,
  splitAssetWav,
  verifyAssetWav,
  type AssetAction,
  type AssetPath,
  type AssetPeerPath,
} from '../remote/assets'
import { AssetTransfers } from '../ui/AssetTransfers'
import type { AudioAsset } from '../model/types'

function tone(length = 8000): AudioAsset {
  return {
    id: 'buf_vocal',
    name: 'Vocal',
    sampleRate: 48000,
    channels: [Float32Array.from({ length }, (_, index) => Math.sin(index / 9) * 0.35)],
  }
}

function peer(id: string, path: AssetPath, buffered = 0): AssetPeerPath {
  return { id, path, buffered }
}

async function consume(target: AssetExchange, from: string, actions: AssetAction[], path: AssetPath) {
  const completed: AudioAsset[] = []
  const replies: AssetAction[] = []
  for (const action of actions) {
    if (action.text) replies.push(...await target.handleControl(from, action.text, path))
    if (action.binary) completed.push(...(await target.handleBinary(from, bytesToArrayBuffer(action.binary))).completed)
  }
  return { completed, replies }
}

describe('peer asset transfer', () => {
  it('keeps audio off a relay and does not change the relay cap', () => {
    expect(chooseAssetPath(false, 'host')).toBe('closed')
    expect(chooseAssetPath(true, undefined)).toBe('unknown')
    expect(chooseAssetPath(true, 'relay')).toBe('relay')
    expect(chooseAssetPath(true, 'host')).toBe('direct')
    expect(chooseAssetPath(true, 'srflx')).toBe('direct')
    expect(assetBytesAllowed('direct')).toBe(true)
    expect(assetBytesAllowed('relay')).toBe(false)
    expect(assetBytesAllowed('unknown')).toBe(false)
    const relay = [{ selected: true, candidateType: 'relay' as const, bytesSent: 5_000_000, bytesReceived: 5_000_000 }]
    expect(assetRelayCredit('relay', relay)).toBe(0)
    expect(assetRelayCredit('closed', relay)).toBe(0)
    expect(assetRelayCredit('direct', [{ selected: true, candidateType: 'host', bytesSent: 80, bytesReceived: 20 }])).toBe(0)
    expect(capGigabytes('750')).toBe(750)
    expect(capGigabytes(undefined)).toBe(500)
  })

  it('round-trips a lossless 32-bit wav, rejects a hole, and checks the checksum', async () => {
    const asset = tone(8000)
    const wav = encodeLosslessWav(asset.channels, asset.sampleRate)
    expect(wav.byteLength).toBeGreaterThan(ASSET_CHUNK_BYTES)
    const pieces = splitAssetWav(wav)
    expect(pieces.length).toBeGreaterThan(1)
    const parts: Array<Uint8Array | undefined> = []
    for (let index = 0; index < pieces.length; index++) {
      const read = readAssetChunk(bytesToArrayBuffer(packAssetChunk(index, pieces.length, pieces[index])))
      expect(read?.index).toBe(index)
      expect(read?.total).toBe(pieces.length)
      parts[index] = read?.bytes
    }
    const holed = parts.slice()
    holed[1] = undefined
    expect(missingChunkIndexes(holed, pieces.length)).toEqual([1])
    expect(assembleAssetWav(holed, pieces.length)).toBeNull()
    const joined = assembleAssetWav(parts, pieces.length)
    expect(joined).not.toBeNull()
    expect(await verifyAssetWav(joined!, await verifyHash(joined!))).toBe(true)
    joined![80] ^= 0xff
    expect(await verifyAssetWav(joined!, await verifyHash(wav))).toBe(false)
    const decoded = decodeWavPCM(bytesToArrayBuffer(wav))
    expect(decoded.sampleRate).toBe(48000)
    expect(decoded.channels[0][100]).toBe(asset.channels[0][100])
    expect(decoded.channels[0][4000]).toBe(asset.channels[0][4000])
  })

  it('rejects a signaling catalog that carries audio bytes', () => {
    const offer = {
      id: 'buf_vocal',
      name: 'Vocal',
      sampleRate: 48000,
      bytes: ASSET_CHUNK_BYTES,
      sha256: 'ab'.repeat(32),
      total: 1,
    }
    expect(offersFromSignal({ assets: [offer] })?.[0].id).toBe('buf_vocal')
    expect(offersFromSignal({ assets: [{ ...offer, wav: 'UklGRg==' }] })).toBeNull()
    expect(offersFromSignal({ assets: [{ ...offer, chunk: 'aaaa' }] })).toBeNull()
    expect(offersFromSignal({ wav: 'abcd', assets: [offer] })).toBeNull()
    expect(parseAssetControl(JSON.stringify({ t: 'want', id: 'buf_vocal', sha256: 'ab'.repeat(32), have: [0, 0, 2] }))).toEqual({
      t: 'want',
      id: 'buf_vocal',
      sha256: 'ab'.repeat(32),
      have: [0, 2],
    })
  })

  it('asks any direct peer that has the file and skips a relay', () => {
    expect(pickAssetPeer({
      selfId: 'late',
      holders: ['host', 'guest', 'late'],
      paths: { host: 'relay', guest: 'direct', late: 'direct' },
    })).toBe('guest')
    expect(pickAssetPeer({
      selfId: 'late',
      holders: ['host', 'guest'],
      paths: { host: 'direct', guest: 'direct' },
      skip: ['guest'],
    })).toBe('host')
    expect(pickAssetPeer({
      selfId: 'late',
      holders: ['host'],
      paths: { host: 'relay' },
    })).toBeNull()
  })

  it('moves a checksummed wav to a late joiner through whichever peer already has it', async () => {
    const asset = tone(8000)
    const store = memoryAssetStore()
    const host = new AssetExchange(memoryAssetStore())
    const guest = new AssetExchange(store)
    const arrived = await transfer(host, guest, 'host', 'guest', asset)
    expect(arrived.channels[0][100]).toBe(asset.channels[0][100])
    expect(arrived.channels[0][4000]).toBe(asset.channels[0][4000])
    const saved = await store.getAsset('buf_vocal')
    expect(saved?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await verifyAssetWav(saved!.wav, saved!.sha256)).toBe(true)
    const resumed = new AssetExchange(store)
    const again = await resumed.tick({ selfId: 'guest', held: [], referenced: ['buf_vocal'], peers: [peer('host', 'direct')] })
    expect(again.completed[0].channels[0][100]).toBe(asset.channels[0][100])
    expect(again.actions.some((action) => action.text?.includes('"want"'))).toBe(false)

    const late = new AssetExchange(memoryAssetStore())
    const listed = await guest.tick({ selfId: 'guest', held: [arrived], referenced: ['buf_vocal'], peers: [peer('late', 'direct')] })
    expect(listed.signal?.[0].id).toBe('buf_vocal')
    late.noteCatalog('guest', listed.signal || [])
    late.noteCatalog('host', [{ ...listed.signal![0] }])
    const asked = await late.tick({
      selfId: 'late',
      held: [],
      referenced: ['buf_vocal'],
      peers: [peer('host', 'closed'), peer('guest', 'direct')],
    })
    expect(asked.actions.find((action) => action.text?.includes('"want"'))?.peerId).toBe('guest')
    const reply = await consume(guest, 'late', asked.actions, 'direct')
    const got = await consume(late, 'guest', reply.replies, 'direct')
    expect(got.completed[0].channels[0][250]).toBe(asset.channels[0][250])
    expect(late.currentStatuses().find((item) => item.id === 'buf_vocal')?.label).toBe('Saved on this device')
  })

  it('resumes from the slices already stored and sends nothing over a relay', async () => {
    const asset = tone(40_000)
    const pieces = splitAssetWav(encodeLosslessWav(asset.channels, asset.sampleRate))
    expect(pieces.length).toBeGreaterThan(ASSET_CHUNKS_PER_TURN)
    const store = memoryAssetStore()
    const host = new AssetExchange(memoryAssetStore())
    const guest = new AssetExchange(store)
    const listed = await host.tick({ selfId: 'host', held: [asset], referenced: ['buf_vocal'], peers: [peer('guest', 'direct')] })
    guest.noteCatalog('host', listed.signal || [])
    const asked = await guest.tick({ selfId: 'guest', held: [], referenced: ['buf_vocal'], peers: [peer('host', 'direct')] })
    const first = await consume(host, 'guest', asked.actions, 'direct')
    const binaries = first.replies.filter((action) => action.binary)
    expect(binaries.length).toBe(ASSET_CHUNKS_PER_TURN)
    await consume(guest, 'host', first.replies, 'direct')
    const partial = await store.getPartial('buf_vocal')
    const stored = partial?.parts.filter((part) => part && part.byteLength > 0).length || 0
    expect(stored).toBe(ASSET_CHUNKS_PER_TURN)
    const resumed = new AssetExchange(store)
    resumed.noteCatalog('host', listed.signal || [])
    const again = await resumed.tick({ selfId: 'guest', held: [], referenced: ['buf_vocal'], peers: [peer('host', 'direct')] })
    const want = parseAssetControl(again.actions.find((action) => action.text)?.text || '')
    expect(want?.t).toBe('want')
    if (want?.t !== 'want') throw new Error('expected a resume request')
    expect(want.have).toHaveLength(stored)
    const rest = await consume(host, 'guest', again.actions, 'direct')
    const sentIndexes = rest.replies.filter((action) => action.binary).map((action) => readAssetChunk(bytesToArrayBuffer(action.binary!))?.index)
    expect(sentIndexes.length).toBeGreaterThan(0)
    for (const index of sentIndexes) expect(want.have).not.toContain(index)
    let audio = (await consume(resumed, 'host', rest.replies, 'direct')).completed
    if (!audio.length) {
      const more = await host.tick({ selfId: 'host', held: [asset], referenced: ['buf_vocal'], peers: [peer('guest', 'direct')] })
      audio = (await consume(resumed, 'host', more.actions, 'direct')).completed
    }
    expect(audio[0].channels[0][10]).toBe(asset.channels[0][10])

    const blocked = new AssetExchange(memoryAssetStore())
    blocked.noteCatalog('host', listed.signal || [])
    const waiting = await blocked.tick({ selfId: 'guest', held: [], referenced: ['buf_vocal'], peers: [peer('host', 'relay')] })
    expect(waiting.actions.some((action) => action.binary)).toBe(false)
    expect(waiting.statuses.find((row) => row.id === 'buf_vocal')?.label).toBe('Waiting for a direct link')
    const refused = await host.handleControl('guest', JSON.stringify({ t: 'want', id: 'buf_vocal', sha256: listed.signal?.[0].sha256, have: [] }), 'relay')
    expect(refused.some((action) => action.binary)).toBe(false)
    expect(refused.some((action) => action.text?.includes('"wait"'))).toBe(true)
    expect(assetRelayCredit('relay', [{ selected: true, candidateType: 'relay', bytesSent: 9_000_000, bytesReceived: 1 }])).toBe(0)
  })

  it('lets a View seat request audio and refuses to publish it', async () => {
    const asset = tone(8000)
    const view = new AssetExchange(memoryAssetStore())
    const quiet = await view.tick({
      selfId: 'view',
      held: [asset],
      referenced: ['buf_vocal'],
      peers: [peer('late', 'direct')],
      publish: false,
    })
    expect(quiet.signal ?? []).toEqual([])
    expect(quiet.actions.some((action) => action.binary || action.text?.includes('"want"'))).toBe(false)
    const refused = await view.handleControl('late', JSON.stringify({ t: 'want', id: 'buf_vocal', sha256: 'ab'.repeat(32), have: [] }), 'direct')
    expect(refused.some((action) => action.binary)).toBe(false)
    expect(refused.some((action) => action.text?.includes('"miss"'))).toBe(true)

    const listener = new AssetExchange(memoryAssetStore())
    const host = new AssetExchange(memoryAssetStore())
    const listed = await host.tick({ selfId: 'host', held: [asset], referenced: ['buf_vocal'], peers: [peer('view', 'direct')] })
    listener.noteCatalog('host', listed.signal || [])
    const need = await listener.tick({
      selfId: 'view',
      held: [],
      referenced: ['buf_vocal'],
      peers: [peer('host', 'direct')],
      publish: false,
    })
    expect(need.actions.some((action) => action.text?.includes('"want"'))).toBe(true)
    expect(need.actions.some((action) => action.binary)).toBe(false)
    expect(need.signal ?? []).toEqual([])
  })

  it('shows a labeled transfer row', () => {
    expect(assetStatusLabel('receiving', 0.4, false)).toBe('Receiving 40%')
    expect(assetStatusLabel('waiting', 0, false)).toBe('Waiting for a direct link')
    const html = renderToStaticMarkup(createElement(AssetTransfers, {
      rows: [{ id: 'buf_vocal', name: 'Vocal', phase: 'receiving', progress: 0.4, label: 'Receiving 40%' }],
    }))
    expect(html).toContain('Vocal')
    expect(html).toContain('Receiving 40%')
    expect(html).toContain('asset-transfer')
    expect(html).not.toContain('<svg')
  })

  it('keeps each transfer row at least 40px tall on a phone and a fold', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/remoteFixes.css']
      .map((file) => readFileSync(resolve(root, file), 'utf8'))
      .join('\n')
    const row = renderToStaticMarkup(createElement(AssetTransfers, {
      rows: [{ id: 'buf_vocal', name: 'Vocal', phase: 'receiving', progress: 0.4, label: 'Receiving 40%' }],
    }))
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of [
        { width: 390, height: 844, shell: 'phone' },
        { width: 768, height: 900, shell: 'fold' },
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.setContent(`<!doctype html><style>${css}</style><body><div class="shell ${viewport.shell}">${row}</div></body>`, { waitUntil: 'load' })
        const box = await page.locator('.asset-transfer').boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(40)
        expect(await page.locator('.asset-transfer-name').innerText()).toBe('Vocal')
        expect(await page.locator('.asset-transfer-state').innerText()).toBe('Receiving 40%')
      }
    } finally {
      await browser.close()
    }
  })
})

async function verifyHash(bytes: Uint8Array) {
  return hashWav(bytes)
}

async function transfer(source: AssetExchange, target: AssetExchange, sourceId: string, targetId: string, asset: AudioAsset) {
  let toSource: AssetAction[] = []
  let toTarget: AssetAction[] = []
  for (let turn = 0; turn < 12; turn++) {
    const fromSource = await source.tick({ selfId: sourceId, held: [asset], referenced: [asset.id], peers: [peer(targetId, 'direct')] })
    const fromTarget = await target.tick({ selfId: targetId, held: [], referenced: [asset.id], peers: [peer(sourceId, 'direct')] })
    if (fromSource.signal) target.noteCatalog(sourceId, fromSource.signal)
    if (fromTarget.signal) source.noteCatalog(targetId, fromTarget.signal)
    toTarget.push(...fromSource.actions)
    toSource.push(...fromTarget.actions)
    const atSource = await consume(source, targetId, toSource, 'direct')
    const atTarget = await consume(target, sourceId, toTarget, 'direct')
    if (atTarget.completed[0]) return atTarget.completed[0]
    toSource = atTarget.replies
    toTarget = atSource.replies
  }
  throw new Error('asset did not arrive')
}
