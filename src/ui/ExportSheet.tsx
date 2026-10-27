import { useEffect, useRef, useState } from 'react'
import { BounceCancelled, runBounce, type BounceJob, type BounceKind } from '../audio/bounce'
import { decodeWavPCM } from '../model/wav'
import type { ProjectStore } from '../state/store'
import { shareOrDownload } from './share'

export function ExportSheet({
  store,
  phone,
  onClose,
  onFreeze,
}: {
  store: ProjectStore
  phone: boolean
  onClose: () => void
  onFreeze: (audio: { sampleRate: number; channels: Float32Array[] }, start: number) => void
}) {
  const [format, setFormat] = useState<BounceKind>('wav')
  const [advanced, setAdvanced] = useState(false)
  const [scope, setScope] = useState<BounceJob['scope']>('song')
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [tail, setTail] = useState<'auto' | number>('auto')
  const [rate, setRate] = useState(48000)
  const [bits, setBits] = useState<16 | 24 | 32>(24)
  const [dither, setDither] = useState<BounceJob['dither']>('tpdf')
  const [normalize, setNormalize] = useState<BounceJob['normalize']>('off')
  const [target, setTarget] = useState(-14)
  const [limiter, setLimiter] = useState(false)
  const [mp3Mode, setMp3Mode] = useState<'cbr' | 'vbr'>('cbr')
  const [bitrate, setBitrate] = useState(320)
  const [quality, setQuality] = useState(2)
  const [audio, setAudio] = useState<'wav' | 'flac'>('wav')
  const [stems, setStems] = useState<'all' | 'selected'>('all')
  const [title, setTitle] = useState(store.project.name)
  const [artist, setArtist] = useState('')
  const [artwork, setArtwork] = useState<Uint8Array | null>(null)
  const [progress, setProgress] = useState(0)
  const [running, setRunning] = useState(false)
  const cancel = useRef(false)
  const worker = useRef<Worker | null>(null)

  useEffect(() => () => {
    worker.current?.terminate()
  }, [])

  async function run() {
    cancel.current = false
    setRunning(true)
    setProgress(0.02)
    const clip = store.findClip(store.selectedClipId || '')
    const selectionStart = clip?.clip.startSample ?? 0
    const selectionEnd = clip ? clip.clip.startSample + clip.clip.durationSamples : store.project.loopEndSample
    const job: BounceJob = {
      kind: format,
      project: store.project,
      assets: [...store.buffers.values()],
      scope: format === 'track' ? 'selection' : scope,
      startSample: scope === 'selection' || format === 'track' ? selectionStart : Math.round(start * store.project.sampleRate),
      endSample: scope === 'selection' || format === 'track' ? selectionEnd : Math.round((end || store.project.loopEndSample / store.project.sampleRate) * store.project.sampleRate),
      tail,
      sampleRate: rate,
      bits,
      dither,
      normalize,
      normalizeTarget: target,
      limiter,
      stemIds: stems === 'selected' && store.selectedTrackId ? [store.selectedTrackId] : null,
      trackId: store.selectedTrackId,
      mp3Mode,
      mp3Bitrate: bitrate,
      mp3Quality: quality,
      title,
      artist,
      artwork,
      projectAudio: audio,
    }
    try {
      const files = await bounceWithWorker(job, setProgress, () => cancel.current, worker)
      if (cancel.current) return
      if (format === 'track' && files[0]) {
        const decoded = decodeWavPCM(files[0].bytes.buffer.slice(files[0].bytes.byteOffset, files[0].bytes.byteOffset + files[0].bytes.byteLength) as ArrayBuffer)
        onFreeze({ sampleRate: decoded.sampleRate, channels: decoded.channels }, job.startSample)
      } else {
        for (const file of files) {
          await shareOrDownload(file.name, new Blob([file.bytes.slice()], { type: file.mime }), phone)
        }
      }
      setProgress(1)
    } catch (error) {
      if (!(error instanceof BounceCancelled) && (error as Error)?.name !== 'BounceCancelled') store.toast('Export failed.', 'warn')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" id="export-sheet" onClick={(event) => event.stopPropagation()}>
        <h2>Export</h2>
        <select id="export-format" aria-label="Format" value={format} onChange={(event) => setFormat(event.target.value as BounceKind)}>
          <option value="wav">WAV</option>
          <option value="mp3">MP3</option>
          <option value="flac">FLAC</option>
          <option value="stems">Stems</option>
          <option value="midi">MIDI</option>
          <option value="project">Project</option>
          <option value="track">Freeze</option>
        </select>
        <button className="text-btn" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>Advanced</button>
        {advanced && (
          <div className="stack">
            <select aria-label="Scope" value={scope} onChange={(event) => setScope(event.target.value as BounceJob['scope'])}>
              <option value="song">Song</option>
              <option value="loop">Loop</option>
              <option value="selection">Selection</option>
              <option value="time">Time</option>
            </select>
            {scope === 'time' && (
              <div className="row-btns">
                <input aria-label="Start" type="number" min={0} step={0.1} value={start} onChange={(event) => setStart(Number(event.target.value))} />
                <input aria-label="End" type="number" min={0} step={0.1} value={end} onChange={(event) => setEnd(Number(event.target.value))} />
              </div>
            )}
            <select aria-label="Tail" value={tail === 'auto' ? 'auto' : 'seconds'} onChange={(event) => setTail(event.target.value === 'auto' ? 'auto' : 2)}>
              <option value="auto">Tail auto</option>
              <option value="seconds">Tail seconds</option>
            </select>
            {tail !== 'auto' && <input aria-label="Tail seconds" type="number" min={0} step={0.1} value={tail} onChange={(event) => setTail(Number(event.target.value))} />}
            <select aria-label="Rate" value={rate} onChange={(event) => setRate(Number(event.target.value))}>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
              <option value={96000}>96 kHz</option>
            </select>
            <select aria-label="Bits" value={bits} onChange={(event) => setBits(Number(event.target.value) as 16 | 24 | 32)}>
              <option value={16}>16-bit</option>
              <option value={24}>24-bit</option>
              <option value={32}>32-float</option>
            </select>
            <select aria-label="Dither" value={dither} onChange={(event) => setDither(event.target.value as BounceJob['dither'])}>
              <option value="none">Dither off</option>
              <option value="tpdf">TPDF</option>
              <option value="shaped">Shaped</option>
            </select>
            <select aria-label="Normalize" value={normalize} onChange={(event) => setNormalize(event.target.value as BounceJob['normalize'])}>
              <option value="off">Normalize off</option>
              <option value="peak">Peak</option>
              <option value="lufs">LUFS</option>
            </select>
            {normalize !== 'off' && <input aria-label="Target" type="number" step={0.1} value={target} onChange={(event) => setTarget(Number(event.target.value))} />}
            <button className={`text-btn ${limiter ? 'on' : ''}`} aria-pressed={limiter} onClick={() => setLimiter((value) => !value)}>Limiter</button>
            <select aria-label="MP3 mode" value={mp3Mode} onChange={(event) => setMp3Mode(event.target.value as 'cbr' | 'vbr')}>
              <option value="cbr">CBR</option>
              <option value="vbr">VBR</option>
            </select>
            <input aria-label="Bitrate" type="number" min={128} max={320} step={32} value={bitrate} onChange={(event) => setBitrate(Number(event.target.value))} />
            <input aria-label="Quality" type="number" min={0} max={9} step={1} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
            <select aria-label="Stems" value={stems} onChange={(event) => setStems(event.target.value as 'all' | 'selected')}>
              <option value="all">All tracks</option>
              <option value="selected">Selected</option>
            </select>
            <select aria-label="Project audio" value={audio} onChange={(event) => setAudio(event.target.value as 'wav' | 'flac')}>
              <option value="wav">Keep WAV</option>
              <option value="flac">FLAC</option>
            </select>
            <input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
            <input aria-label="Artist" value={artist} onChange={(event) => setArtist(event.target.value)} />
            <input aria-label="Artwork" type="file" accept="image/png,image/jpeg" onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              void file.arrayBuffer().then((buffer) => setArtwork(new Uint8Array(buffer)))
            }} />
          </div>
        )}
        {running && <progress className="export-progress" value={progress} max={1} />}
        <div className="row-btns">
          <button className="text-btn" onClick={() => { cancel.current = true; worker.current?.postMessage({ type: 'cancel' }); worker.current?.terminate(); onClose() }}>Cancel</button>
          <button className="text-btn primary" id="export-run" disabled={running} onClick={() => void run()}>Export</button>
        </div>
      </div>
    </div>
  )
}

function bounceWithWorker(job: BounceJob, onProgress: (value: number) => void, shouldCancel: () => boolean, workerRef: { current: Worker | null }) {
  if (typeof Worker === 'undefined') return runBounce(job, onProgress, shouldCancel)
  return new Promise<Awaited<ReturnType<typeof runBounce>>>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../audio/bounceWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      void runBounce(job, onProgress, shouldCancel).then(resolve, reject)
      return
    }
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<{ type: string; progress?: number; files?: { name: string; mime: string; bytes: ArrayBuffer }[]; message?: string }>) => {
      if (event.data.type === 'progress' && event.data.progress != null) onProgress(event.data.progress)
      if (event.data.type === 'done' && event.data.files) {
        worker.terminate()
        resolve(event.data.files.map((file) => ({ name: file.name, mime: file.mime, bytes: new Uint8Array(file.bytes) })))
      }
      if (event.data.type === 'error') {
        worker.terminate()
        if (event.data.message === 'Cancelled') reject(new BounceCancelled())
        else reject(new Error(event.data.message || 'Bounce failed'))
      }
    }
    worker.onerror = () => {
      worker.terminate()
      void runBounce(job, onProgress, shouldCancel).then(resolve, reject)
    }
    worker.postMessage({ type: 'start', job })
  })
}
