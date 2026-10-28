import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { GENRES, LOUDNESS_TARGETS, analyzeMix, buildChain, loudnessMatch, matchEq, octaveBands, targetById, targetVerdict } from '../audio/master/assistant'
import { masterAlbum, masterDistribution, sharedChain } from '../audio/master/batch'
import { renderArrangement } from '../audio/bounce'
import { measureProgram } from '../audio/master/meter'
import { projectEndSample } from '../model/time'
import { decodeWavPCM, linearResample } from '../model/wav'
import { listProjects, loadProject } from '../storage/idb'
import { selectMaster } from '../state/select'
import type { ProjectStore } from '../state/store'
import { formFactor } from './form'
import { InsertList } from './PluginSheet'
import { shareOrDownload } from './share'

export function MasterSheet({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const [genre, setGenre] = useState<(typeof GENRES)[number]>('Pop')
  const [intensity, setIntensity] = useState(0.6)
  const [targetId, setTargetId] = useState('spotify')
  const [chain, setChain] = useState(false)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('Analyze, then edit the chain.')
  const [live, setLive] = useState<Record<string, number> | null>(null)
  const [reference, setReference] = useState<Float32Array[] | null>(null)
  const [refGain, setRefGain] = useState(1)
  const [refBands, setRefBands] = useState<number[] | null>(null)
  const [match, setMatch] = useState<{ lowG: number; midG: number; highG: number; midF: number } | null>(null)
  const [ab, setAb] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [isrc, setIsrc] = useState('')
  const spectrum = useRef<HTMLCanvasElement>(null)
  const scope = useRef<HTMLCanvasElement>(null)
  const history = useRef<number[][]>([])
  const target = targetById(targetId)
  const verdict = targetVerdict(live?.integrated ?? -70, live?.truePeak ?? -70, target)

  useEffect(() => {
    let timer = 0
    const tick = () => {
      const reading = engine.masterReading()
      if (reading) setLive((prev) => (sameReading(prev, reading) ? prev : { ...reading }))
      const meter = selectMaster(store).plugins.find((plugin) => plugin.pluginId === 'meter')
      drawMeters(spectrum.current, scope.current, meter ? engine.spectrum(meter.id) : null, engine.masterScope(), refBands, history.current)
      if (chain) drawSpectrogram(document.querySelector('#master-sheet .spectrogram'), history.current)
      timer = window.setTimeout(tick, 180)
    }
    timer = window.setTimeout(tick, 180)
    return () => window.clearTimeout(timer)
  }, [chain, engine, refBands, store])

  useEffect(() => () => engine.stopAudition(), [engine])

  async function mixAudio() {
    const length = Math.min(store.project.sampleRate * 20, Math.max(store.project.sampleRate, projectEndSample(store.project.tracks, store.project.sampleRate, store.project.tempo)))
    return renderArrangement(store.project, new Map(store.buffers), 0, length, false)
  }

  async function apply() {
    setBusy('Analyzing')
    try {
      const audio = await mixAudio()
      const report = analyzeMix(audio[0] ?? new Float32Array(0), audio[1] ?? null, store.project.sampleRate, genre, target)
      setNote(report.notes.join(' · '))
      setRefBands(report.bands)
      store.replaceMasterChain(buildChain(report.integrated <= -60 ? null : report, genre, intensity, target))
    } catch {
      store.replaceMasterChain(buildChain(null, genre, intensity, target))
      setNote('Preset chain')
    } finally {
      setBusy('')
    }
  }

  async function compare() {
    if (comparing) {
      store.setMasterBypass(false)
      engine.setCompareGain(1)
      setComparing(false)
      setNote('Chain on')
      return
    }
    setBusy('Matching')
    try {
      const wet = await mixAudio()
      const dryProject = {
        ...store.project,
        masterPlugins: store.project.masterPlugins.map((plugin) => (plugin.pluginId === 'meter' ? plugin : { ...plugin, enabled: false })),
      }
      const dry = await renderArrangement(dryProject, new Map(store.buffers), 0, wet[0]?.length ?? store.project.sampleRate, false)
      const wetReading = measureProgram(wet[0] ?? new Float32Array(0), wet[1] ?? null, store.project.sampleRate)
      const dryReading = measureProgram(dry[0] ?? new Float32Array(0), dry[1] ?? null, store.project.sampleRate)
      engine.setCompareGain(loudnessMatch(dryReading.integrated, wetReading.integrated))
      store.setMasterBypass(true)
      setComparing(true)
      setNote('Loudness matched')
    } catch {
      store.toast('Compare needs a mix.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function loadReference(file: File) {
    setBusy('Reference')
    try {
      const bytes = await file.arrayBuffer()
      let decoded: { sampleRate: number; channels: Float32Array[] }
      try {
        decoded = decodeWavPCM(bytes)
      } catch {
        const ctx = new AudioContext()
        const audio = await ctx.decodeAudioData(bytes.slice(0))
        const left = new Float32Array(audio.getChannelData(0))
        const right = new Float32Array(audio.getChannelData(audio.numberOfChannels > 1 ? 1 : 0))
        decoded = { sampleRate: audio.sampleRate, channels: [left, right] }
        await ctx.close()
      }
      const rate = store.project.sampleRate
      const channels = decoded.sampleRate === rate ? decoded.channels : decoded.channels.map((channel) => linearResample(channel, decoded.sampleRate, rate))
      const mix = await mixAudio()
      const refReading = measureProgram(channels[0], channels[1] ?? null, rate)
      const mixReading = measureProgram(mix[0] ?? new Float32Array(0), mix[1] ?? null, rate)
      setReference(channels)
      setRefGain(loudnessMatch(refReading.integrated, mixReading.integrated))
      setMatch(matchEq(mix[0] ?? new Float32Array(0), channels[0], rate))
      setRefBands(octaveBands(channels[0], rate))
      setNote('Reference matched')
    } catch {
      store.toast('Could not read that file.', 'warn')
    } finally {
      setBusy('')
    }
  }

  function toggleReference() {
    if (ab) {
      engine.stopAudition()
      setAb(false)
      return
    }
    if (!reference) return
    engine.audition(reference, refGain)
    setAb(true)
  }

  function applyMatch() {
    if (!match) return
    const suggestion = match
    const current = store.project.masterPlugins.find((plugin) => plugin.pluginId === 'meq')
    if (current) {
      store.updatePlugin('master', current.id, { params: suggestion })
      setNote('Match EQ')
      return
    }
    const plugins = buildChain(null, genre, intensity, target)
    plugins[0].params = { ...plugins[0].params, ...suggestion }
    store.replaceMasterChain(plugins)
    setNote('Match EQ')
  }

  async function exportPair() {
    setBusy('Exporting')
    try {
      const phone = formFactor(window.innerWidth, window.innerHeight) !== 'desk'
      const files = await masterDistribution(store.project, [...store.buffers.values()], target, isrc.trim())
      for (const file of files) await shareOrDownload(file.name, new Blob([file.bytes.slice()], { type: file.mime }), phone)
      setNote('WAV 24-bit and MP3')
    } catch {
      store.toast('Export failed.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function album() {
    setBusy('Album')
    try {
      const phone = formFactor(window.innerWidth, window.innerHeight) !== 'desk'
      const listed = await listProjects()
      const entries = []
      for (const item of listed.slice(0, 8)) {
        const loaded = await loadProject(item.id)
        if (loaded) entries.push({ project: loaded.project, assets: [...loaded.buffers.values()] })
      }
      if (!entries.some((entry) => entry.project.id === store.project.id)) {
        entries.unshift({ project: store.project, assets: [...store.buffers.values()] })
      }
      const zip = await masterAlbum(entries, sharedChain(store.project), target, isrc.trim())
      await shareOrDownload(zip.name, new Blob([zip.bytes.slice()], { type: zip.mime }), phone)
      setNote(`${Math.min(8, entries.length)} songs`)
    } catch {
      store.toast('Album export failed.', 'warn')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="plugin-sheet master-sheet" id="master-sheet" role="dialog" aria-label="Master">
      <header>
        <strong>Master</strong>
        <select aria-label="Genre" value={genre} onChange={(event) => setGenre(event.target.value as (typeof GENRES)[number])}>
          {GENRES.map((name) => <option key={name}>{name}</option>)}
        </select>
        <button id="master-apply" className="text-btn" disabled={!!busy} onClick={() => void apply()}>{busy || 'Apply'}</button>
        <button id="master-chain" className={`text-btn ${chain ? 'on' : ''}`} aria-expanded={chain} onClick={() => setChain((open) => !open)}>Chain</button>
        <button className="text-btn" onClick={onClose}>×</button>
      </header>
      <label className="wet">
        Intensity
        <input aria-label="Intensity" type="range" min={0} max={1} step={0.01} value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} />
      </label>
      <div className="master-meters" id="master-readout">
        <span><b>{shown(live?.integrated)}</b> I</span>
        <span><b>{shown(live?.shortTerm)}</b> S</span>
        <span><b>{shown(live?.momentary)}</b> M</span>
        <span><b>{shown(live?.lra)}</b> LRA</span>
        <span><b>{shown(live?.truePeak)}</b> dBTP</span>
        <span><b>{shown(live?.correlation, 2)}</b> Corr</span>
      </div>
      <div className="row">
        <select aria-label="Target" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {LOUDNESS_TARGETS.map((item) => <option key={item.id} value={item.id}>{item.name} {item.lufs}</option>)}
        </select>
        <b className={`verdict ${verdict}`}>{verdict === 'wait' ? '—' : verdict === 'pass' ? 'Pass' : 'Fail'}</b>
        <span className="readout">{note}</span>
      </div>
      <div className="master-scope">
        <canvas ref={spectrum} width={320} height={72} className="spectrum" aria-label="Spectrum" />
        <canvas ref={scope} width={72} height={72} className="goniometer" aria-label="Goniometer" />
      </div>
      <div className="row">
        <label className="text-btn file-btn">
          Reference
          <input aria-label="Reference" type="file" accept="audio/*,.wav,.mp3,.flac" onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadReference(file)
          }} />
        </label>
        <button className={`text-btn ${ab ? 'on' : ''}`} disabled={!reference} onClick={toggleReference}>{ab ? 'Mix' : 'A/B'}</button>
        <button className="text-btn" disabled={!reference} onClick={applyMatch}>Match EQ</button>
        <button className={`text-btn ${comparing ? 'on' : ''}`} disabled={!!busy} onClick={() => void compare()}>{comparing ? 'Master' : 'Bypass'}</button>
      </div>
      {chain && (
        <div id="master-chain-body">
          <InsertList store={store} trackId="master" />
          <canvas width={320} height={64} className="spectrogram" aria-label="Spectrogram" ref={(node) => drawSpectrogram(node, history.current)} />
        </div>
      )}
      <div className="row">
        <input aria-label="ISRC" placeholder="ISRC" value={isrc} onChange={(event) => setIsrc(event.target.value)} />
        <button className="text-btn" disabled={!!busy} onClick={() => void exportPair()}>WAV + MP3</button>
        <button className="text-btn" disabled={!!busy} onClick={() => void album()}>Album</button>
      </div>
    </div>
  )
}

function shown(value: number | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value) || value <= -60) return '—'
  return value.toFixed(digits)
}

function sameReading(prev: Record<string, number> | null, next: Record<string, number>) {
  if (!prev) return false
  return Math.abs((prev.integrated ?? 0) - (next.integrated ?? 0)) < 0.05 && Math.abs((prev.truePeak ?? 0) - (next.truePeak ?? 0)) < 0.05
}

function drawMeters(spectrum: HTMLCanvasElement | null, scope: HTMLCanvasElement | null, bins: Float32Array | null, pairs: Float32Array | null, reference: number[] | null, history: number[][]) {
  const ctx = spectrum?.getContext('2d')
  if (ctx && spectrum) {
    ctx.clearRect(0, 0, spectrum.width, spectrum.height)
    ctx.fillStyle = '#73c48f'
    const count = bins?.length ?? 32
    const slot = spectrum.width / count
    const row: number[] = []
    for (let i = 0; i < count; i++) {
      const mag = bins ? Math.min(1, (bins[i] || 0) * 4) : 0
      row.push(mag)
      ctx.fillRect(i * slot, spectrum.height - mag * spectrum.height, Math.max(1, slot - 1), mag * spectrum.height)
    }
    if (reference?.length) {
      ctx.strokeStyle = '#e0b15a'
      ctx.beginPath()
      reference.forEach((band, index) => {
        const x = ((index + 0.5) / reference.length) * spectrum.width
        const y = spectrum.height * (0.5 - Math.max(-12, Math.min(12, band)) / 24)
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
    history.push(row)
    if (history.length > 40) history.shift()
  }
  const pen = scope?.getContext('2d')
  if (pen && scope) {
    pen.clearRect(0, 0, scope.width, scope.height)
    pen.strokeStyle = 'rgba(115,196,143,0.85)'
    pen.beginPath()
    const n = pairs?.length ?? 0
    for (let i = 0; i + 1 < n; i += 2) {
      const left = pairs?.[i] || 0
      const right = pairs?.[i + 1] || 0
      const x = scope.width / 2 + (right - left) * scope.width * 0.4
      const y = scope.height / 2 - (left + right) * scope.height * 0.4
      if (i === 0) pen.moveTo(x, y)
      else pen.lineTo(x, y)
    }
    pen.stroke()
  }
}

function drawSpectrogram(node: Element | null, history: number[][]) {
  const canvas = node instanceof HTMLCanvasElement ? node : null
  const ctx = canvas?.getContext('2d')
  if (!ctx || !canvas || !history.length) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const rowH = canvas.height / history.length
  history.forEach((row, y) => {
    const slot = canvas.width / Math.max(1, row.length)
    row.forEach((mag, x) => {
      const light = Math.round(40 + mag * 180)
      ctx.fillStyle = `rgb(${light}, ${120 + light / 3}, ${90 + light / 4})`
      ctx.fillRect(x * slot, y * rowH, Math.max(1, slot), Math.max(1, rowH))
    })
  })
}

