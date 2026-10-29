import { useEffect, useMemo, useRef, useState } from 'react'
import { CATALOG } from '../audio/plugins/catalog'
import { MASTERING_IDS } from '../audio/master/assistant'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import { SoundBrowser } from './SoundBrowser'
import { TipButton } from './Hint'
import { PatternSend, patternBeat } from './PatternSend'
import { quickDragArmed } from './clipKeys'

export type BrowserTab = 'sounds' | 'instruments' | 'loops' | 'patterns' | 'plugins' | 'clips'

const TABS: { id: BrowserTab; label: string; hint: string }[] = [
  { id: 'sounds', label: 'Sounds', hint: 'Loops, one-shots, and instruments from the free library.' },
  { id: 'instruments', label: 'Instruments', hint: 'Starter instruments. Drag one onto an instrument track.' },
  { id: 'loops', label: 'Loops', hint: 'Loops that follow the song tempo.' },
  { id: 'patterns', label: 'Patterns', hint: 'Patterns from the Beats rack. Drag one onto the playlist.' },
  { id: 'plugins', label: 'Plugins', hint: 'Effects you insert on a track.' },
  { id: 'clips', label: 'Clips', hint: 'Clips already in this project.' },
]

const PATTERN_MIME = 'application/x-cueharbor-pattern'
const PLUGIN_MIME = 'application/x-cueharbor-plugin'

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
  holdLibraryPack?: (trackId: string, pack: import('../audio/multisample/types').SamplePack) => void
  auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
}

export function PlaylistBrowser({
  store,
  engine,
  phone,
  tab,
  onTab,
  onClose,
  onSeek,
}: {
  store: ProjectStore
  engine: PreviewEngine
  phone: boolean
  tab: BrowserTab
  onTab: (tab: BrowserTab) => void
  onClose: () => void
  onSeek: (sample: number) => void
}) {
  const project = store.project
  const [query, setQuery] = useState('')
  const dragging = useRef(false)
  const pointerDropped = useRef(0)
  const needle = query.trim().toLowerCase()
  const trackId = store.selectedTrackId || project.tracks[0]?.id || ''

  useEffect(() => {
    const allow = (event: DragEvent) => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes(PATTERN_MIME) && !types.includes(PLUGIN_MIME)) return
      event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('.playlist-browser')) return
      const patternId = event.dataTransfer?.getData(PATTERN_MIME)
      const pluginId = event.dataTransfer?.getData(PLUGIN_MIME)
      if (!patternId && !pluginId) return
      const inner = target.closest('.timeline-inner') as HTMLElement | null
      const lane = target.closest('[data-track]') as HTMLElement | null
      if (!inner && !lane) return
      event.preventDefault()
      const px = Number(inner?.dataset.px) || 90
      const rect = inner?.getBoundingClientRect()
      const sample = rect ? Math.max(0, ((event.clientX - rect.left) / px) * project.sampleRate) : engine.currentTimelineSample()
      if (patternId) {
        if (performance.now() - pointerDropped.current < 500) return
        store.selectPattern(patternId)
        store.placePattern(Math.max(0, projectSampleBeat(project, sample)), lane?.dataset.track)
        return
      }
      const id = lane?.dataset.track || trackId
      if (pluginId && id) {
        store.addPlugin(id, pluginId)
        const name = CATALOG.find((item) => item.id === pluginId)?.name ?? pluginId
        store.toast(`${name} is on the track.`, 'good')
      }
    }
    window.addEventListener('dragover', allow)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', allow)
      window.removeEventListener('drop', drop)
    }
  }, [engine, project, store, trackId])

  function dropPattern(clientX: number, clientY: number, patternId: string) {
    const hit = document.elementFromPoint(clientX, clientY)
    if (!hit || hit.closest('.playlist-browser')) return
    const lane = hit.closest('[data-track]') as HTMLElement | null
    const inner = (hit.closest('.timeline-inner') ?? document.querySelector('.timeline-inner')) as HTMLElement | null
    if (!inner && !lane) return
    const px = Number(inner?.dataset.px) || 90
    const rect = inner?.getBoundingClientRect()
    const sample = rect ? Math.max(0, ((clientX - rect.left) / px) * project.sampleRate) : engine.currentTimelineSample()
    store.selectPattern(patternId)
    store.placePattern(Math.max(0, projectSampleBeat(project, sample)), lane?.dataset.track)
  }

  const patterns = useMemo(
    () => (project.beats?.patterns ?? []).filter((item) => !needle || item.name.toLowerCase().includes(needle)),
    [needle, project.beats],
  )
  const plugins = useMemo(
    () => CATALOG.filter((item) => item.id !== 'meter' && !(MASTERING_IDS as readonly string[]).includes(item.id) && (!needle || item.name.toLowerCase().includes(needle))),
    [needle],
  )
  const clips = useMemo(() => {
    const rows: { id: string; name: string; where: string; sample: number; trackId: string; midi: boolean }[] = []
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.slotOnly) continue
        rows.push({ id: clip.id, name: clip.name, where: track.name, sample: clip.startSample, trackId: track.id, midi: false })
      }
      for (const clip of track.midiClips) {
        if (clip.slotOnly || clip.scene != null) continue
        rows.push({
          id: clip.id,
          name: clip.name,
          where: track.name,
          sample: Math.round(projectBeatSample(project, clip.startBeat)),
          trackId: track.id,
          midi: true,
        })
      }
    }
    for (const clip of project.patternClips ?? []) {
      if (clip.scene != null) continue
      const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
      rows.push({
        id: clip.id,
        name: pattern?.name || 'Pattern',
        where: 'Pattern',
        sample: Math.round(projectBeatSample(project, clip.startBeat)),
        trackId: clip.trackId || trackId,
        midi: false,
      })
    }
    return rows.filter((row) => !needle || `${row.name} ${row.where}`.toLowerCase().includes(needle))
  }, [needle, project, trackId])

  const soundLock = tab === 'instruments' ? 'instrument' : tab === 'loops' ? 'loop' : tab === 'sounds' ? 'all' : null

  return (
    <aside className="playlist-browser" data-playlist-browser="open" aria-label="Browser">
      <div className="browser-tabs">
        {phone ? (
          <select aria-label="Browser section" value={tab} onChange={(event) => onTab(event.target.value as BrowserTab)}>
            {TABS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        ) : (
          TABS.map((item) => (
            <button key={item.id} type="button" className={tab === item.id ? 'on' : ''} title={item.hint} aria-pressed={tab === item.id} onClick={() => onTab(item.id)}>
              {item.label}
            </button>
          ))
        )}
        <TipButton label="Hide" hint="Hide the browser. The playlist stays put." onClick={onClose} />
      </div>
      {soundLock ? (
        <SoundBrowser
          store={store}
          engine={engine}
          phone={false}
          embedded
          lockType={soundLock === 'all' ? undefined : soundLock}
          onClose={onClose}
        />
      ) : (
        <div className="browser-body">
          <input aria-label="Search the browser" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="browser-list">
            {tab === 'patterns' && (
              <PatternSend store={store} beat={patternBeat(store, engine.currentTimelineSample())} phone={phone} />
            )}
            {tab === 'patterns' && patterns.map((pattern) => (
              <button
                key={pattern.id}
                type="button"
                className="browser-row"
                title="Drag onto the playlist. It lands on the lane under the pointer."
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  dragging.current = false
                  const startX = event.clientX
                  const startY = event.clientY
                  const node = event.currentTarget
                  const move = (ev: PointerEvent) => {
                    if (!quickDragArmed(ev.clientX - startX, ev.clientY - startY)) return
                    dragging.current = true
                    if (!node.hasPointerCapture(ev.pointerId)) node.setPointerCapture(ev.pointerId)
                  }
                  const up = (ev: PointerEvent) => {
                    node.removeEventListener('pointermove', move)
                    node.removeEventListener('pointerup', up)
                    node.removeEventListener('pointercancel', up)
                    if (!dragging.current) return
                    pointerDropped.current = performance.now()
                    dropPattern(ev.clientX, ev.clientY, pattern.id)
                  }
                  node.addEventListener('pointermove', move)
                  node.addEventListener('pointerup', up)
                  node.addEventListener('pointercancel', up)
                }}
                onClick={() => {
                  if (dragging.current) return
                  store.selectPattern(pattern.id)
                  store.placePattern(Math.max(0, projectSampleBeat(project, engine.currentTimelineSample())))
                }}
              >
                <i style={{ background: pattern.color }} />
                <strong>{pattern.name}</strong>
                <span>{pattern.steps} steps</span>
              </button>
            ))}
            {tab === 'plugins' && plugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className="browser-row"
                draggable={!phone}
                title="Insert this effect on the selected track."
                onPointerDown={() => { dragging.current = false }}
                onDragStart={(event) => {
                  dragging.current = true
                  event.dataTransfer.setData(PLUGIN_MIME, plugin.id)
                  event.dataTransfer.setData('text/plain', plugin.id)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => {
                  if (dragging.current || !trackId) return
                  store.addPlugin(trackId, plugin.id)
                  store.toast(`${plugin.name} is on the track.`, 'good')
                }}
              >
                <strong>{plugin.name}</strong>
                <span>Insert</span>
              </button>
            ))}
            {tab === 'clips' && clips.map((clip) => (
              <button
                key={clip.id}
                type="button"
                className="browser-row"
                title="Select this clip and move the playhead to it."
                onClick={() => {
                  store.selectClip(clip.trackId, clip.id, clip.midi, false)
                  onSeek(clip.sample)
                }}
              >
                <strong>{clip.name}</strong>
                <span>{clip.where}</span>
              </button>
            ))}
            {tab === 'patterns' && !patterns.length && <p>No patterns yet.</p>}
            {tab === 'clips' && !clips.length && <p>No clips on the playlist yet.</p>}
          </div>
        </div>
      )}
    </aside>
  )
}
