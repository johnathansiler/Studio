/** Inline chop editor. Menus hang off the button that opened them. Nothing here leaves the device. */

import { useRef, useState, type ChangeEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { preparePadPcm } from '../instruments/mpc/render'
import { captureSlot, openInputCapture, SLOT_ACCEPT } from '../audio/sample/slot'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { loadSoundCatalog } from '../sounds/catalog'
import { decodeSoundBytes } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import {
  FACTORY_VINTAGE,
  assignPlan,
  fitToTempo,
  keyLabel,
  parseVintagePresets,
  shiftedKey,
  slicesFor,
  upsertVintagePreset,
  type ChopMode,
  type ChopSetup,
  type TempoGrid,
  type VintagePreset,
  type VintageTable,
} from '../model/padChop'
import { setPadVintage } from './padVoiceAdapter'
import { WaveformView } from './WaveformView'
import type { ProjectStore } from '../state/store'

const PRESET_KEY = 'cueharbor-vintage-presets'
const GRIDS: { id: TempoGrid; label: string }[] = [
  { id: 'bar', label: '1 bar' },
  { id: 'half', label: '1/2' },
  { id: 'quarter', label: '1/4' },
  { id: 'eighth', label: '1/8' },
  { id: 'sixteenth', label: '1/16' },
]

export function ChopDrawer({
  store,
  engine,
  trackId,
  vintageStartsOpen = false,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  /** First paint only. The live menu still toggles from the knob's button. */
  vintageStartsOpen?: boolean
}) {
  const kit = store.trackKit(trackId)
  const chop = kit.chop
  const asset = chop ? store.buffers.get(chop.bufferId) : undefined
  const samples = asset?.channels[0]
  const sampleRate = asset?.sampleRate || store.project.sampleRate
  const slices = chop && samples ? slicesFor(chop, samples, sampleRate, store.project.tempo) : []
  const plan = assignPlan(slices.length)
  const fileRef = useRef<HTMLInputElement>(null)
  const chopping = useRef(false)
  const [snapZero, setSnapZero] = useState(true)
  const [loadOpen, setLoadOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [vintageOpen, setVintageOpen] = useState(vintageStartsOpen)
  const [presetTick, setPresetTick] = useState(0)
  const [presetDraft, setPresetDraft] = useState('')
  const [browser, setBrowser] = useState<SoundEntry[] | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const vintage = kit.vintage
  const scaled = setPadVintage(vintage)

  function patch(next: Partial<ChopSetup>) {
    store.patchChop(trackId, next)
  }

  function applyPreset(preset: VintagePreset) {
    setPresetDraft(preset.name)
    store.patchTrackKit(trackId, { vintage: { macro: vintage?.macro ?? 1, table: preset.table, presetName: preset.name } })
  }

  function savePreset() {
    const table = vintage?.table ?? FACTORY_VINTAGE[0].table
    const name = (presetDraft || vintage?.presetName || 'My vintage').trim() || 'My vintage'
    const next = upsertVintagePreset(savedPresets(), name, table)
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)) } catch { /* the kit still keeps this blend */ }
    store.patchTrackKit(trackId, { vintage: { macro: vintage?.macro ?? 1, table, presetName: name } })
    setPresetTick((tick) => tick + 1)
  }

  async function useSamples(name: string, channel: Float32Array, rate: number) {
    store.setChopSample(trackId, channel, rate, name)
    setLoadOpen(false)
    setBrowser(null)
  }

  async function fromBrowser(entry: SoundEntry) {
    const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
    const decoded = await decodeSoundBytes(bytes)
    const channel = decoded.channels[0]
    if (channel?.length) await useSamples(entry.name, channel, decoded.sampleRate)
  }

  async function fromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const decoded = await decodeSoundBytes(await file.arrayBuffer())
    const channel = decoded.channels[0]
    if (channel?.length) await useSamples(file.name, channel, decoded.sampleRate)
  }

  async function fromStream(stream: MediaStream, name: string) {
    const ctx = engine.unlock()
    const capture = await openInputCapture({
      deviceId: '',
      stream,
      context: ctx,
      channel: 0,
      request: async () => stream,
    })
    try {
      const audio = await captureSlot(capture.source, {
        countIn: false,
        bars: 2,
        tempo: store.project.tempo,
        signature: store.project.timeSignature,
        maxSamples: Math.round(capture.source.sampleRate * 8),
      }, {
        shouldStop: () => false,
        onLevel: () => undefined,
        onPhase: () => undefined,
        wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      })
      if (!audio) return
      const channel = audio.channels[0]
      if (channel?.length) await useSamples(name, channel, audio.sampleRate)
    } finally {
      capture.close()
    }
  }

  async function fromMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    await fromStream(stream, 'Microphone')
  }

  async function fromTab() {
    const media = navigator.mediaDevices?.getDisplayMedia
    if (!media) {
      store.toast('This browser cannot record a tab.', 'warn')
      return
    }
    const stream = await media.call(navigator.mediaDevices, { video: true, audio: true })
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop())
      store.toast('Choose a tab and share its audio. The recording stays on this device.', 'info')
      return
    }
    await fromStream(stream, 'Tab audio')
  }

  function audition(index: number) {
    if (!samples || !slices[index]) return
    const slice = slices[index]
    const region = { start: slice.start / samples.length, end: slice.end / samples.length, loop: false, loopStart: 0, loopEnd: 1, reverse: false }
    engine.playBuffer(preparePadPcm(samples, region), 60, 1)
  }

  function placeMarker(fraction: number) {
    if (!chop || chop.mode !== 'manual') return
    const at = Math.min(0.98, Math.max(0.02, fraction))
    patch({ markers: [...chop.markers, at].sort((a, b) => a - b) })
  }

  function moveMarker(id: string, fraction: number, phase: 'move' | 'commit') {
    if (!chop) return
    const index = Number(id)
    if (!Number.isInteger(index) || index < 0 || index >= chop.markers.length) return
    const at = Math.min(0.98, Math.max(0.02, fraction))
    if (phase === 'move') {
      if (!chopping.current) {
        chopping.current = true
        store.beginAutomationTouch()
      }
      const markers = chop.markers.slice()
      markers[index] = at
      patch({ markers })
      return
    }
    if (!chopping.current) return
    chopping.current = false
    const markers = chop.markers.slice()
    markers[index] = at
    const sorted = markers.slice().sort((a, b) => a - b)
    patch({ markers: sorted })
    setPicked(sorted.indexOf(at))
    store.endAutomationTouch()
  }

  const label = chop ? `${shiftedKey(chop.root, chop.modeName, chop.semitones, chop.cents)}, ${Math.round((chop.tempoSource === 'sample' ? chop.sampleBpm : store.project.tempo) * 10) / 10} BPM` : 'No sample yet'
  const fit = chop ? fitToTempo(chop.sampleBpm || store.project.tempo, store.project.tempo) : null

  return (
    <section className="chop-drawer" aria-label="Chop" data-chop="open">
      <div className="chop-bar">
        <div className="chop-anchor">
          <button type="button" className="hw-key ch-tab" aria-expanded={loadOpen} onClick={() => { setLoadOpen((value) => !value); setModeOpen(false); setVintageOpen(false) }}>Load sample</button>
          {loadOpen && (
            <div className="chop-menu" role="group" aria-label="Load sample">
              <button type="button" className="hw-key ch-tab" onClick={() => { void loadSoundCatalog(fetch, soundCache()).then((result) => setBrowser(result.entries.slice(0, 24))) }}>Browser</button>
              <button type="button" className="hw-key ch-tab" onClick={() => fileRef.current?.click()}>Upload</button>
              <button type="button" className="hw-key ch-tab" onClick={() => { void fromMic() }}>Microphone</button>
              <button type="button" className="hw-key ch-tab" onClick={() => { void fromTab() }}>Tab audio</button>
              <input ref={fileRef} className="chop-file" type="file" accept={SLOT_ACCEPT} aria-label="Upload a sample" onChange={(event) => { void fromFile(event) }} />
              {browser && browser.map((entry) => (
                <button key={entry.id} type="button" className="hw-key ch-tab" onClick={() => { void fromBrowser(entry) }}>{entry.name}</button>
              ))}
            </div>
          )}
        </div>
        <div className="chop-anchor">
          <button type="button" className="hw-key ch-tab" aria-expanded={modeOpen} onClick={() => { setModeOpen((value) => !value); setLoadOpen(false); setVintageOpen(false) }}>Chop mode</button>
          {modeOpen && (
            <div className="chop-menu" role="group" aria-label="Chop mode">
              {(['tempo', 'even', 'transient', 'manual'] as ChopMode[]).map((mode) => (
                <button key={mode} type="button" className={`hw-key ch-tab${chop?.mode === mode ? ' on' : ''}`} onClick={() => { if (chop) patch({ mode }); setModeOpen(false) }}>{modeLabel(mode)}</button>
              ))}
            </div>
          )}
        </div>
        <p className="chop-readout" aria-live="polite">{label}</p>
      </div>

      {chop && (
        <>
          <div className="chop-key">
            <label>Key
              <select aria-label="Sample key" value={chop.root} onChange={(event) => patch({ root: Number(event.target.value) })}>
                {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </label>
            <label>Scale
              <select aria-label="Sample scale" value={chop.modeName} onChange={(event) => patch({ modeName: event.target.value === 'major' ? 'major' : 'minor' })}>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
              </select>
            </label>
            <label>Sample BPM
              <input aria-label="Sample BPM" type="number" min={40} max={300} step={0.1} value={chop.sampleBpm} onChange={(event) => patch({ sampleBpm: Number(event.target.value), tempoSource: 'sample' })} />
            </label>
            <button type="button" className={`hw-key ch-tab${chop.tempoSource === 'project' ? ' on' : ''}`} onClick={() => patch({ tempoSource: chop.tempoSource === 'project' ? 'sample' : 'project' })}>{chop.tempoSource === 'project' ? 'Project tempo' : 'Sample tempo'}</button>
          </div>
          <div className="chop-pitch">
            <label>Sample pitch
              <input aria-label="Sample pitch" type="range" min={-12} max={12} step={1} value={chop.semitones} onChange={(event) => patch({ semitones: Number(event.target.value) })} />
            </label>
            <label>Cents
              <input aria-label="Sample cents" type="range" min={-100} max={100} step={1} value={chop.cents} onChange={(event) => patch({ cents: Number(event.target.value) })} />
            </label>
            <button type="button" className={`hw-key ch-tab${chop.pitchMode === 'vinyl' ? ' on' : ''}`} onClick={() => patch({ pitchMode: chop.pitchMode === 'vinyl' ? 'stretch' : 'vinyl' })}>{chop.pitchMode === 'vinyl' ? 'Vinyl' : 'Stretch'}</button>
            <p>{keyLabel(chop.root, chop.modeName)} becomes {shiftedKey(chop.root, chop.modeName, chop.semitones, chop.cents)}</p>
          </div>
          {fit && (
            <div className="chop-fit">
              <button type="button" className="hw-key ch-tab" onClick={() => patch({ semitones: fit.semitones, cents: 0, pitchMode: 'vinyl', tempoSource: 'sample' })}>Fit to tempo</button>
              <p>{fit.semitones > 0 ? '+' : ''}{fit.semitones} semitones, {fit.bpm.toFixed(1)} BPM, {fit.difference.toFixed(1)} BPM apart</p>
              <button type="button" className="hw-key ch-tab" onClick={() => store.setTempo(fit.bpm)}>Set project tempo</button>
            </div>
          )}
          {chop.mode === 'tempo' && (
            <div className="chop-tempo" role="group" aria-label="Tempo chop">
              {GRIDS.map((grid) => (
                <button key={grid.id} type="button" className={`hw-key ch-tab${chop.grid === grid.id ? ' on' : ''}`} onClick={() => patch({ grid: grid.id })}>{grid.label}</button>
              ))}
              <button type="button" className={`hw-key ch-tab${chop.sliceStart === 'start' ? ' on' : ''}`} onClick={() => patch({ sliceStart: 'start' })}>Sample start</button>
              <button type="button" className={`hw-key ch-tab${chop.sliceStart === 'transient' ? ' on' : ''}`} onClick={() => patch({ sliceStart: 'transient' })}>First transient</button>
            </div>
          )}
          {chop.mode === 'even' && (
            <div className="chop-tempo" role="group" aria-label="Even slices">
              {[4, 8, 16].map((count) => (
                <button key={count} type="button" className={`hw-key ch-tab${chop.even === count ? ' on' : ''}`} onClick={() => patch({ even: count as 4 | 8 | 16 })}>{count} slices</button>
              ))}
            </div>
          )}
          {chop.mode === 'transient' && (
            <label className="chop-sense">Sensitivity
              <input aria-label="Transient sensitivity" type="range" min={0} max={1} step={0.01} value={chop.sensitivity} onChange={(event) => patch({ sensitivity: Number(event.target.value) })} />
            </label>
          )}
          <WaveformView
            channel={samples}
            className="chop-wave"
            ariaLabel="Waveform"
            color="#9ec8ff"
            chrome="above"
            snap={snapZero}
            onSnap={setSnapZero}
            markers={chop.mode === 'manual' ? chop.markers.map((marker, index) => ({
              id: String(index),
              at: marker,
              className: `chop-marker${picked === index ? ' on' : ''}`,
              label: `Marker ${index + 1}`,
              title: 'Slice marker. Drag to a zero crossing.',
              name: `Marker ${index + 1}`,
              grip: false,
            })) : []}
            onMarker={(id, fraction, phase) => { setPicked(Number(id)); moveMarker(id, fraction, phase) }}
            onPlace={chop.mode === 'manual' ? (fraction) => placeMarker(fraction) : undefined}
          >
            {(view) => samples ? slices.map((slice, index) => (
              <i key={`${slice.start}-${index}`} className="chop-slice-line" style={{ left: `${view.percent(slice.start / samples.length)}%` }} />
            )) : null}
          </WaveformView>
          {chop.mode === 'manual' && (
            <button type="button" className="hw-key ch-tab" disabled={picked == null} onClick={() => { if (picked == null) return; patch({ markers: chop.markers.filter((_, index) => index !== picked) }); setPicked(null) }}>Remove marker</button>
          )}
          <div className="chop-slices" role="group" aria-label="Slices">
            {slices.slice(0, 16).map((slice, index) => (
              <button key={`${slice.start}-${index}`} type="button" className="hw-key ch-tab" onClick={() => audition(index)}>Slice {index + 1}</button>
            ))}
          </div>
          <p className="chop-left">{plan.left ? `${plan.left} slices left` : 'All slices fit on the pads'}</p>
          <button type="button" className="hw-key ch-tab" onClick={() => store.assignChopToPads(trackId)}>Assign to pads</button>
          <div className="chop-anchor vintage-anchor">
            <label className="vintage-knob">Vintage
              <input className="hw-knob" aria-label="Vintage" title="Vintage. Scales every vintage amount together." type="range" min={0} max={1} step={0.01} value={vintage?.macro ?? 0} style={{ ['--turn' as string]: String(vintage?.macro ?? 0) }} onChange={(event) => store.patchTrackKit(trackId, { vintage: { macro: Number(event.target.value), table: vintage?.table ?? FACTORY_VINTAGE[0].table, presetName: vintage?.presetName ?? '' } })} />
            </label>
            <button type="button" className="hw-key ch-tab" aria-expanded={vintageOpen} onClick={() => setVintageOpen((value) => !value)}>Vintage menu</button>
            {vintageOpen && (
              <div className="chop-menu vintage-menu" role="group" aria-label="Vintage menu">
                <p>Each amount is the sound at 100%. The knob fades all of them from clean to that blend.</p>
                {FACTORY_VINTAGE.map((preset) => (
                  <button key={preset.name} type="button" className="hw-key ch-tab" onClick={() => applyPreset(preset)}>{preset.name}</button>
                ))}
                <label>Preset name
                  <input aria-label="Vintage preset name" value={presetDraft || vintage?.presetName || ''} onChange={(event) => setPresetDraft(event.target.value)} />
                </label>
                <button type="button" className="hw-key ch-tab" onClick={() => savePreset()}>Save preset</button>
                {savedPresets(presetTick).map((preset) => (
                  <button key={preset.name} type="button" className="hw-key ch-tab" onClick={() => applyPreset(preset)}>{preset.name}</button>
                ))}
                {(['wow', 'crackle', 'lowpass', 'bits', 'rate'] as (keyof VintageTable)[]).map((key) => (
                  <label key={key}>{vintageName(key)}
                    <input aria-label={vintageName(key)} type="range" min={0} max={1} step={0.01} value={vintage?.table[key].amount ?? 0} onChange={(event) => {
                      const table = vintage?.table ?? FACTORY_VINTAGE[0].table
                      store.patchTrackKit(trackId, { vintage: { macro: vintage?.macro ?? 0, presetName: vintage?.presetName ?? '', table: { ...table, [key]: { ...table[key], amount: Number(event.target.value) } } } })
                    }} />
                    <select aria-label={`${vintageName(key)} curve`} value={vintage?.table[key].curve ?? 'linear'} onChange={(event) => {
                      const table = vintage?.table ?? FACTORY_VINTAGE[0].table
                      const curve = event.target.value === 'ease' || event.target.value === 'late' ? event.target.value : 'linear'
                      store.patchTrackKit(trackId, { vintage: { macro: vintage?.macro ?? 0, presetName: vintage?.presetName ?? '', table: { ...table, [key]: { ...table[key], curve } } } })
                    }}>
                      <option value="linear">Linear</option>
                      <option value="ease">Ease</option>
                      <option value="late">Late</option>
                    </select>
                    <span>Now {scaled[key].toFixed(2)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="chop-sense">High pass
            <input aria-label="Sample high pass" type="range" min={0} max={1} step={0.01} value={chop.highpass} onChange={(event) => patch({ highpass: Number(event.target.value) })} />
          </label>
        </>
      )}
    </section>
  )
}

function modeLabel(mode: ChopMode) {
  if (mode === 'tempo') return 'Tempo'
  if (mode === 'even') return 'Even'
  if (mode === 'transient') return 'Transient'
  return 'Manual'
}

function vintageName(key: keyof VintageTable) {
  if (key === 'wow') return 'Tape wow and flutter'
  if (key === 'crackle') return 'Vinyl noise and crackle'
  if (key === 'lowpass') return 'Low-pass cutoff'
  if (key === 'bits') return 'Bit depth'
  return 'Sample-rate reduction'
}

function savedPresets(tick = 0): VintagePreset[] {
  void tick
  try {
    return parseVintagePresets(localStorage.getItem(PRESET_KEY))
  } catch {
    return []
  }
}
