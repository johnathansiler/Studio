import { useEffect, useMemo, useRef, useState } from 'react'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import { BROWSER_TAB_EVENT } from './phoneContext'
import { SheetGrab } from './bottomSheet'
import { SheetClose } from './SheetClose'
import { MyLibrary } from './MyLibrary'
import './sound-browser.css'
import { PatternSend, patternBeat } from './PatternSend'
import { quickDragArmed } from './clipKeys'
import { readBrowsePlace, writeBrowsePlace } from './browsePlace'

export type BrowserTab = 'sounds' | 'instruments' | 'loops' | 'library' | 'patterns' | 'clips'

const TABS: { id: BrowserTab; label: string; hint: string }[] = [
  { id: 'library', label: 'My Library', hint: 'Your private library. Sounds stay in the bucket and play from a short-lived link.' },
  { id: 'patterns', label: 'Patterns', hint: 'Patterns from the Beats rack. Drag one onto the playlist.' },
  { id: 'clips', label: 'Clips', hint: 'Clips already in this project.' },
]

const SECTION_TITLE: Record<BrowserTab, string> = {
  sounds: 'My Library',
  instruments: 'My Library',
  loops: 'My Library',
  library: 'My Library',
  patterns: 'Patterns',
  clips: 'Clips',
}

const PATTERN_MIME = 'application/x-cueharbor-pattern'

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number, loop?: boolean) => void
  decodeLibrary?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>
  currentTimelineSample: () => number
  holdLibraryPack?: (trackId: string, pack: import('../audio/multisample/types').SamplePack) => void
  holdLibraryAudio?: (trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) => void
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
  sheet = false,
}: {
  store: ProjectStore
  engine: PreviewEngine
  phone: boolean
  tab: BrowserTab
  onTab: (tab: BrowserTab) => void
  onClose: () => void
  onSeek: (sample: number) => void
  /** Phone Arrange draws this as a bottom sheet instead of a side column. */
  sheet?: boolean
}) {
  const project = store.project
  const opened = readBrowsePlace()
  const [query, setQuery] = useState(tab === 'clips' ? opened.clipText : opened.patternText)
  const [patternFocus, setPatternFocus] = useState(opened.patternFocus)
  const [clipFocus, setClipFocus] = useState(opened.clipFocus)
  const dragging = useRef(false)
  const pointerDropped = useRef(0)
  const needle = query.trim().toLowerCase()
  useEffect(() => {
    if (tab === 'patterns') writeBrowsePlace({ patternText: query })
    if (tab === 'clips') writeBrowsePlace({ clipText: query })
  }, [query, tab])
  useEffect(() => {
    const place = readBrowsePlace()
    const id = tab === 'clips' ? place.clipFocus : place.patternFocus
    if (!id) return
    const row = document.querySelector(`[data-browse-id="${CSS.escape(id)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [tab, patternFocus, clipFocus])
  const trackId = store.selectedTrackId || project.tracks[0]?.id || ''

  useEffect(() => {
    if (!sheet && !phone) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      queueMicrotask(() => {
        if (event.defaultPrevented) return
        if (document.querySelector('.anchored-menu[data-open="true"]:not([hidden])')) return
        onClose()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet, phone, onClose])

  useEffect(() => {
    const allow = (event: DragEvent) => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes(PATTERN_MIME)) return
      event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('.playlist-browser')) return
      const patternId = event.dataTransfer?.getData(PATTERN_MIME)
      if (!patternId) return
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

  const catalog = tab === 'patterns' || tab === 'clips' ? (
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
            className={`browser-row${patternFocus === `pattern:${pattern.id}` ? ' is-kept' : ''}`}
            data-browse-id={`pattern:${pattern.id}`}
            title="In song. Place this pattern on Arrange as a linked clip. Editing the pattern updates every copy. Drag to choose the lane."
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
              setPatternFocus(`pattern:${pattern.id}`)
              writeBrowsePlace({ patternFocus: `pattern:${pattern.id}`, tab: 'patterns' })
              store.selectPattern(pattern.id)
              store.placePattern(Math.max(0, projectSampleBeat(project, engine.currentTimelineSample())))
            }}
          >
            <i style={{ background: pattern.color }} />
            <strong>{pattern.name}</strong>
            <span>{pattern.steps} steps</span>
            <span>Add</span>
          </button>
        ))}
        {tab === 'clips' && clips.map((clip) => (
          <button
            key={clip.id}
            type="button"
            className={`browser-row${clipFocus === `clip:${clip.id}` ? ' is-kept' : ''}`}
            data-browse-id={`clip:${clip.id}`}
            title="Select this clip and move the playhead to it."
            onClick={() => {
              setClipFocus(`clip:${clip.id}`)
              writeBrowsePlace({ clipFocus: `clip:${clip.id}`, tab: 'clips' })
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
  ) : (
    <MyLibrary store={store} engine={engine} />
  )

  return (
    <aside
      className={`playlist-browser${sheet ? ' bottom-sheet' : ''}`}
      data-playlist-browser="open"
      data-bottom-sheet={sheet ? 'open' : undefined}
      aria-label="Browser"
      onPointerDown={sheet ? (event) => event.stopPropagation() : undefined}
    >
      {sheet && <SheetGrab label="Resize browser. Drag up or down." />}
      {phone && (
        <header className="browser-sheet-title sheet-head">
          <strong data-browser-title={tab}>{SECTION_TITLE[tab]}</strong>
          <SheetClose className="browser-close" onClick={onClose} />
        </header>
      )}
      <div className="browser-tabs btn-tray">
        <div className="browser-chip-scroll" role="tablist" aria-label="Browser">
          {TABS.map((item) => (
            <button key={item.id} type="button" className={tab === item.id || (item.id === 'library' && (tab === 'sounds' || tab === 'instruments' || tab === 'loops')) ? 'on' : ''} title={item.hint} aria-pressed={tab === item.id} onClick={() => onTab(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {!phone && <SheetClose className="browser-close" onClick={onClose} />}
      </div>
      {sheet ? <div className="bottom-sheet-body">{catalog}</div> : catalog}
    </aside>
  )
}

/** The same browser, beside Mix or Collab. Arrange draws its own copy in the playlist frame. */
export function ShellBrowser({
  store,
  engine,
  phone,
  onClose,
  onSeek,
}: {
  store: ProjectStore
  engine: PreviewEngine
  phone: boolean
  onClose: () => void
  onSeek: (sample: number) => void
}) {
  const [tab, setTab] = useState<BrowserTab>(readBrowsePlace().tab)
  function chooseTab(next: BrowserTab) {
    const stored = next === 'patterns' || next === 'clips' ? next : 'library'
    setTab(stored)
    writeBrowsePlace({ tab: stored })
  }
  useEffect(() => {
    const onTab = (event: Event) => {
      const next = (event as CustomEvent<BrowserTab>).detail
      if (next) setTab(next)
    }
    document.addEventListener(BROWSER_TAB_EVENT, onTab)
    return () => document.removeEventListener(BROWSER_TAB_EVENT, onTab)
  }, [])
  return <PlaylistBrowser store={store} engine={engine} phone={phone} tab={tab} onTab={chooseTab} onClose={onClose} onSeek={onSeek} />
}
