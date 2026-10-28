import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { analyzeProjectInWorker, transcribeHumInWorker } from '../analysis/job'
import { rememberTrackAnalysis, subscribeAnalysis, summaryLine, trackAnalysis } from '../analysis/cache'
import type { AnalysisResult, HumNote } from '../analysis/types'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'

const SCOPE = 'This track uses the lane you opened. The whole song reads every unmuted track.'
const ANALYZE = 'Detect the key, the chord in each bar, the sections, and the tempo.'
const HUM = 'Record a hummed or sung melody from the mic and turn it into notes.'
const STOP = 'Stop the microphone and transcribe the melody.'
const GRID = 'Snap each transcribed note to this rhythmic grid.'
const PLACE = 'Write the transcribed notes onto a MIDI clip on this track.'
const CLOSE = 'Close the analysis panel.'

const GRIDS: { value: number; label: string }[] = [
  { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' },
  { value: 0.25, label: '1/16' },
  { value: 0, label: 'Off' },
]

export function TrackReadout({ trackId }: { trackId: string }) {
  const result = useSyncExternalStore(subscribeAnalysis, () => trackAnalysis(trackId), () => null)
  if (!result) return null
  return <span className="track-key" title={summaryLine(result)}>{result.key.label}</span>
}

export function AnalysisSheet({
  store,
  trackId,
  onClose,
}: {
  store: ProjectStore
  trackId: string
  onClose: () => void
}) {
  const track = store.project.tracks.find((item) => item.id === trackId)
  const [scope, setScope] = useState<'track' | 'song'>('track')
  const [grid, setGrid] = useState(0.25)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(() => trackAnalysis(trackId))
  const [notes, setNotes] = useState<HumNote[] | null>(null)
  const [recording, setRecording] = useState(false)
  const stopRef = useRef<(() => Float32Array[]) | null>(null)
  const timerRef = useRef(0)

  useEffect(() => () => {
    window.clearTimeout(timerRef.current)
    stopRef.current?.()
    stopRef.current = null
  }, [])

  const run = async () => {
    if (!track) return
    setError('')
    setStatus('Analyzing…')
    try {
      const project = scope === 'track' ? projectOf(store.project, track.id) : store.project
      const buffers = assetsFor(project, store.buffers)
      const result = await analyzeProjectInWorker(project, buffers)
      rememberTrackAnalysis(track.id, result)
      setAnalysis(result)
      setStatus('')
    } catch (caught) {
      setStatus('')
      setError(caught instanceof Error ? caught.message : 'Analysis failed')
    }
  }

  const transcribe = (chunks: Float32Array[]) => {
    void finishHum(chunks, store.project.tempo, store.project.timeSignature, grid, setNotes, setStatus, setError)
  }

  const hum = async () => {
    if (recording && stopRef.current) {
      window.clearTimeout(timerRef.current)
      const chunks = stopRef.current()
      stopRef.current = null
      setRecording(false)
      transcribe(chunks)
      return
    }
    setError('')
    try {
      const handle = await startMic()
      stopRef.current = handle.stop
      setRecording(true)
      setStatus('Listening… hum a melody, then stop.')
      timerRef.current = window.setTimeout(() => {
        if (!handle.alive() || !stopRef.current) return
        const chunks = stopRef.current()
        stopRef.current = null
        setRecording(false)
        transcribe(chunks)
      }, 20000)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Microphone unavailable')
    }
  }

  const place = () => {
    if (!notes?.length) return
    const host = track?.type === 'midi' ? track : store.project.tracks.find((item) => item.type === 'midi')
    if (!host) {
      setError('Add a MIDI track to hold the melody.')
      return
    }
    const existing = host.midiClips.find((clip) => clip.id === store.selectedMidiClipId)
    let clipId = existing?.id ?? null
    if (!clipId) {
      store.addMidiClip(host.id, 0)
      clipId = store.selectedMidiClipId
    }
    if (!clipId) return
    store.addPerformedNotes(
      host.id,
      clipId,
      notes.map((note) => ({
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        velocity: note.velocity,
      })),
      'replace',
    )
    setStatus(`Placed ${notes.length} notes on ${host.name}`)
  }

  return (
    <div className="analysis-sheet" role="dialog" aria-label="Analysis">
      <header>
        <strong>{track ? track.name : 'Analysis'}</strong>
        <button type="button" className="text-btn" aria-describedby="analysis-close-hint" onClick={onClose}>Close</button>
      </header>
      <p className="hint" id="analysis-close-hint">{CLOSE}</p>
      <label className="analysis-field">
        Listen to
        <select aria-label="Analysis scope" aria-describedby="analysis-scope-hint" value={scope} onChange={(event) => setScope(event.target.value === 'song' ? 'song' : 'track')}>
          <option value="track">This track</option>
          <option value="song">Whole song</option>
        </select>
      </label>
      <p className="hint" id="analysis-scope-hint">{SCOPE}</p>
      <div className="row">
        <button type="button" className="text-btn primary" aria-describedby="analysis-run-hint" disabled={!track || recording} onClick={() => void run()}>Analyze</button>
        <button type="button" className="text-btn" aria-describedby="analysis-hum-hint" onClick={() => void hum()}>{recording ? 'Stop' : 'Hum'}</button>
        <label className="analysis-field">
          Grid
          <select aria-label="Hum grid" aria-describedby="analysis-grid-hint" value={String(grid)} onChange={(event) => setGrid(Number(event.target.value))}>
            {GRIDS.map((item) => <option key={item.label} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <p className="hint" id="analysis-run-hint">{ANALYZE}</p>
      <p className="hint" id="analysis-hum-hint">{recording ? STOP : HUM}</p>
      <p className="hint" id="analysis-grid-hint">{GRID}</p>
      {status && <p className="readout">{status}</p>}
      {error && <p className="hint">{error}</p>}
      {analysis && (
        <div className="analysis-result">
          <p className="readout">{analysis.key.label} · {analysis.scale} · {Math.round(analysis.tempo)} bpm</p>
          <div className="chords" aria-label="Chords">
            {analysis.chordsByBar.map((chord) => (
              <span className="chord" key={`${chord.bar}-${chord.symbol}`}>{chord.bar + 1} {chord.symbol}</span>
            ))}
          </div>
          <ul className="sections">
            {analysis.sections.map((section) => (
              <li key={`${section.startBar}-${section.label}`}>{section.label} · bars {section.startBar + 1}–{section.endBar}</li>
            ))}
          </ul>
        </div>
      )}
      {notes && notes.length > 0 && (
        <>
          <p className="readout">{notes.map((note) => noteName(note.pitch)).join(' ')}</p>
          <button type="button" className="text-btn" aria-describedby="analysis-place-hint" onClick={place}>Place notes</button>
          <p className="hint" id="analysis-place-hint">{PLACE}</p>
        </>
      )}
    </div>
  )
}

function noteName(pitch: number) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const pc = ((pitch % 12) + 12) % 12
  return `${names[pc]}${Math.floor(pitch / 12) - 1}`
}

function projectOf(project: Project, trackId: string): Project {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) return { ...project, tracks: [] }
  return { ...project, tracks: [{ ...track, mute: false }] }
}

function assetsFor(project: Project, buffers: ProjectStore['buffers']) {
  const map = new Map<string, { sampleRate: number; channels: ArrayLike<number>[] }>()
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.slotOnly) continue
      const asset = buffers.get(clip.bufferId)
      if (asset && !map.has(asset.id)) map.set(asset.id, { sampleRate: asset.sampleRate, channels: asset.channels })
    }
  }
  return map
}

async function finishHum(
  chunks: Float32Array[],
  tempo: number,
  timeSignature: { numerator: number; denominator: number },
  grid: number,
  setNotes: (notes: HumNote[]) => void,
  setStatus: (text: string) => void,
  setError: (text: string) => void,
) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const channel = new Float32Array(length)
  let at = 0
  for (const chunk of chunks) {
    channel.set(chunk, at)
    at += chunk.length
  }
  setStatus('Transcribing…')
  try {
    const heard = await transcribeHumInWorker(
      { sampleRate: 48000, channels: [channel], tempo, timeSignature },
      { tempo, grid },
    )
    setNotes(heard)
    setStatus(heard.length ? '' : 'No melody heard')
  } catch (caught) {
    setStatus('')
    setError(caught instanceof Error ? caught.message : 'Transcription failed')
  }
}

function startMic() {
  const chunks: Float32Array[] = []
  let alive = true
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  }).then((stream) => {
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    const sink = ctx.createGain()
    sink.gain.value = 0
    proc.onaudioprocess = (event) => {
      if (!alive) return
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }
    source.connect(proc)
    proc.connect(sink)
    sink.connect(ctx.destination)
    const sampleRate = ctx.sampleRate || 48000
    return {
      alive: () => alive,
      stop: () => {
        if (!alive) return chunks
        alive = false
        proc.disconnect()
        source.disconnect()
        sink.disconnect()
        for (const track of stream.getTracks()) track.stop()
        void ctx.close()
        if (sampleRate !== 48000 && chunks.length) {
          return [resample(concat(chunks), sampleRate, 48000)]
        }
        return chunks
      },
    }
  })
}

function concat(chunks: Float32Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function resample(input: Float32Array, from: number, to: number) {
  const outLen = Math.max(1, Math.round((input.length * to) / from))
  const out = new Float32Array(outLen)
  const ratio = input.length / outLen
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = input[Math.min(input.length - 1, i0)] || 0
    const b = input[Math.min(input.length - 1, i0 + 1)] || 0
    out[i] = a + (b - a) * frac
  }
  return out
}
