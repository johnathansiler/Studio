export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export async function zipFiles(entries: ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const compressed = await deflateRaw(entry.data)
    const method = compressed ? 8 : 0
    const payload = compressed ?? entry.data
    const local = new Uint8Array(30 + name.length + payload.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x800, true)
    view.setUint16(8, method, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint32(14, crc32(entry.data), true)
    view.setUint32(18, payload.length, true)
    view.setUint32(22, entry.data.length, true)
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true)
    local.set(name, 30)
    local.set(payload, 30 + name.length)
    locals.push(local)
    const dir = new Uint8Array(46 + name.length)
    const dirView = new DataView(dir.buffer)
    dirView.setUint32(0, 0x02014b50, true)
    dirView.setUint16(4, 20, true)
    dirView.setUint16(6, 20, true)
    dirView.setUint16(8, 0x800, true)
    dirView.setUint16(10, method, true)
    dirView.setUint32(16, crc32(entry.data), true)
    dirView.setUint32(20, payload.length, true)
    dirView.setUint32(24, entry.data.length, true)
    dirView.setUint16(28, name.length, true)
    dirView.setUint32(42, offset, true)
    dir.set(name, 46)
    central.push(dir)
    offset += local.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of locals) {
    out.set(part, cursor)
    cursor += part.length
  }
  for (const part of central) {
    out.set(part, cursor)
    cursor += part.length
  }
  out.set(end, cursor)
  return out
}

export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 30 <= bytes.length) {
    const sig = view.getUint32(offset, true)
    if (sig === 0x02014b50 || sig === 0x06054b50) break
    if (sig !== 0x04034b50) throw new Error('Not a zip file')
    const method = view.getUint16(offset + 8, true)
    const compSize = view.getUint32(offset + 18, true)
    const nameLen = view.getUint16(offset + 26, true)
    const extraLen = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen))
    const dataStart = nameStart + nameLen + extraLen
    const payload = bytes.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? payload : await inflateRaw(payload)
    entries.push({ name, data })
    offset = dataStart + compSize
  }
  if (!entries.length) throw new Error('Empty zip')
  return entries
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined' || !data.length) return null
  const stream = new Blob([copyBytes(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const out = new Uint8Array(await new Response(stream).arrayBuffer())
  return out.length < data.length ? out : null
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('Cannot inflate this zip')
  const stream = new Blob([copyBytes(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function copyBytes(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength)
  new Uint8Array(copy).set(data)
  return copy
}
