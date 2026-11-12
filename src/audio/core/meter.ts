/**
 * Lock-free peak cell. One writer, one reader.
 * SharedArrayBuffer is used only when the caller already has one.
 * The page does not turn on COOP/COEP: that would block Hugging Face, jsDelivr, and WebRTC.
 */

export const METER_STRIDE = 4

const scratch = new ArrayBuffer(4)
const scratchFloat = new Float32Array(scratch)
const scratchInt = new Int32Array(scratch)
const intViews = new WeakMap<object, Int32Array>()

export function meterBusSamples(channels: number) {
  return Math.max(1, channels) * METER_STRIDE
}

export function createMeterBus(channels: number, shared = false) {
  const samples = meterBusSamples(channels)
  if (shared && typeof SharedArrayBuffer !== 'undefined') {
    try {
      return new Float32Array(new SharedArrayBuffer(samples * 4))
    } catch {
      return new Float32Array(samples)
    }
  }
  return new Float32Array(samples)
}

function intsOf(bus: Float32Array) {
  let view = intViews.get(bus.buffer)
  if (!view) {
    view = new Int32Array(bus.buffer as ArrayBuffer)
    intViews.set(bus.buffer, view)
  }
  return view
}

function store(bus: Float32Array, index: number, value: number) {
  if (typeof SharedArrayBuffer !== 'undefined' && bus.buffer instanceof SharedArrayBuffer && typeof Atomics !== 'undefined') {
    scratchFloat[0] = value
    Atomics.store(intsOf(bus), index, scratchInt[0])
    return
  }
  bus[index] = value
}

function load(bus: Float32Array, index: number) {
  if (typeof SharedArrayBuffer !== 'undefined' && bus.buffer instanceof SharedArrayBuffer && typeof Atomics !== 'undefined') {
    scratchInt[0] = Atomics.load(intsOf(bus), index)
    return scratchFloat[0]
  }
  return bus[index] || 0
}

export interface MeterReading {
  peak: number
  rms: number
  /** Loudest peak since the UI last consumed it. A one-block drum hit stays here. */
  hold: number
  seq: number
}

/** Write the block peak. The hold stays up until `consumeMeter` so a short hit is not missed between UI polls. */
export function writeMeter(bus: Float32Array, channel: number, peak: number, rms: number) {
  const base = channel * METER_STRIDE
  const next = Math.max(0, peak)
  const held = load(bus, base + 2)
  store(bus, base, next)
  store(bus, base + 1, Math.max(0, rms))
  store(bus, base + 2, next >= held ? next : held)
  store(bus, base + 3, load(bus, base + 3) + 1)
}

export function readMeter(bus: Float32Array, channel: number): MeterReading {
  const base = channel * METER_STRIDE
  return {
    peak: load(bus, base),
    rms: load(bus, base + 1),
    hold: load(bus, base + 2),
    seq: load(bus, base + 3),
  }
}

/** UI has painted the hold. The next quiet block may fall. */
export function consumeMeter(bus: Float32Array, channel: number): MeterReading {
  const reading = readMeter(bus, channel)
  store(bus, channel * METER_STRIDE + 2, reading.peak)
  return reading
}

