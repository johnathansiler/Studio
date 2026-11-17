import { RateStreamer, WavDecoder, peakOutline } from './wavStream'

interface Job {
  decoder: WavDecoder
  rate: RateStreamer | null
  toRate: number
  held: Float32Array[] | null
}

const jobs = new Map<number, Job>()
const workerScope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void }

function hold(job: Job, slice: Float32Array[]) {
  if (!job.held) {
    job.held = slice
    return
  }
  job.held = job.held.map((channel, index) => {
    const next = new Float32Array(channel.length + slice[index].length)
    next.set(channel)
    next.set(slice[index], channel.length)
    return next
  })
}

function flush(id: number, job: Job, sampleRate: number, final: boolean) {
  const held = job.held
  if (!held?.[0]?.length) return
  job.held = null
  const transfer = held.map((channel) => channel.buffer)
  workerScope.postMessage({ id, type: 'slice', channels: held, sampleRate, final }, transfer)
}

function pump(id: number, job: Job, done: boolean) {
  const info = job.decoder.ready()
  if (!info) {
    if (done) workerScope.postMessage({ id, type: 'error', message: 'That sound file could not be read.' })
    return
  }
  if (!job.rate) job.rate = new RateStreamer(job.decoder.fileChannels, info.frames, info.sampleRate, job.toRate || info.sampleRate)
  const slice = job.rate.take(job.decoder.decodedFrames, info.frames)
  if (slice?.[0]?.length) hold(job, slice)
  const audioDone = job.decoder.decodedFrames >= info.frames
  const finished = done && audioDone
  const count = job.held?.[0]?.length ?? 0
  if (count >= 4096 || (audioDone && count > 0)) flush(id, job, job.toRate || info.sampleRate, audioDone)
  if (!finished) {
    if (done && job.decoder.decodedFrames < info.frames) workerScope.postMessage({ id, type: 'error', message: 'That sound file ended early.' })
    return
  }
  const channels = job.decoder.fileChannels.map((channel) => channel.slice(0, job.decoder.decodedFrames))
  const matched = job.rate?.rateMatched() ?? []
  const peaks = peakOutline(channels[0] ?? new Float32Array(), 64)
  const transfer = [...channels, ...matched].map((channel) => channel.buffer)
  workerScope.postMessage({ id, type: 'file', sampleRate: info.sampleRate, channels, matched, matchedRate: job.toRate || info.sampleRate, peaks }, transfer)
  jobs.delete(id)
}

self.onmessage = (event: MessageEvent<{ id: number; type: 'start'; toRate: number } | { id: number; type: 'chunk'; bytes: ArrayBuffer; done: boolean } | { id: number; type: 'cancel' }>) => {
  const message = event.data
  if (message.type === 'cancel') {
    jobs.delete(message.id)
    return
  }
  if (message.type === 'start') {
    jobs.set(message.id, { decoder: new WavDecoder(), rate: null, toRate: message.toRate, held: null })
    return
  }
  const job = jobs.get(message.id)
  if (!job) return
  if (message.bytes?.byteLength) job.decoder.push(new Uint8Array(message.bytes))
  pump(message.id, job, message.done)
}
