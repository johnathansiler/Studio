import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'
import { SheetGrab } from './bottomSheet'
import { SheetClose } from './SheetClose'
import { SoundBrowser } from './SoundBrowser'
import { PatternSend, patternBeat } from './PatternSend'
import { quickDragArmed } from './clipKeys'

export type BrowserTab = 'sounds' | 'instruments' | 'loops' | 'patterns' | 'clips'

const TABS: { id: BrowserTab; label: string; hint: string }[] = [
  { id: 'sounds', label: 'Sounds', hint: 'Loops, one-shots, drums, and instruments from the free library.' },
  { id: 'instruments', label: 'Instruments', hint: 'Multi-sampled instruments. One tap loads the selected MIDI track.' },
  { id: 'loops', label: 'Loops', hint: 'Melodic and drum loops that follow the song tempo.' },
]

const PROJECT: { id: 'patterns' | 'clips'; label: string; hint: string }[] = [
  { id: 'patterns', label: 'Patterns', hint: 'Patterns from the Beats rack. Drag one onto the playlist.' },
  { id: 'clips', label: 'Clips', hint: 'Clips already in this project.' },
]

const PATTERN_MIME = 'application/x-cueharbor-pattern'

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
  holdLibraryPack?: (trackId: string, pack: import('../audio/multisample/types').SamplePack) => void
  holdLibraryAudio?: (trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) => void
  auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
}

const HarborBrowser = lazy(() => import('./HarborBrowser').then((mod) => ({ default: mod.HarborBrowser })))

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
  const [query, setQuery] = useState('')
  const dragging = useRef(false)
  const pointerDropped = useRef(0)
  const needle = query.trim().toLowerCase()
  const trackId = store.selectedTrackId || project.tracks[0]?.id || ''

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

  const soundLock = tab === 'instruments' ? 'instrument' : tab === 'loops' ? 'loop' : tab === 'sounds' ? 'all' : null
  const projectOn = tab === 'patterns' || tab === 'clips'
  const projectButton = useRef<HTMLButtonElement>(null)
  const [projectOpen, setProjectOpen] = useState(false)

  const catalog = tab === 'instruments' || tab === 'loops' ? (
    <Suspense fallback={<p className="sound-status">Loading</p>}>
      <HarborBrowser store={store} engine={engine} section={tab} />
    </Suspense>
  ) : soundLock ? (
    <SoundBrowser
      store={store}
      engine={engine}
      phone={phone}
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
      <div className="browser-tabs btn-tray">
        <div className="browser-chip-scroll" role="tablist" aria-label="Browser">
          {TABS.map((item) => (
            <button key={item.id} type="button" className={tab === item.id ? 'on' : ''} title={item.hint} aria-pressed={tab === item.id} onClick={() => onTab(item.id)}>
              {item.label}
            </button>
          ))}
          <button
            ref={projectButton}
            type="button"
            className={projectOn ? 'on' : ''}
            aria-expanded={projectOpen}
            aria-haspopup="menu"
            title="Patterns and clips already in this project."
            onClick={() => setProjectOpen((open) => !open)}
          >
            Project
          </button>
          <AnchoredMenu open={projectOpen} onClose={() => setProjectOpen(false)} label="Project" triggerRef={projectButton} prefer="down">
            {PROJECT.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? 'on' : ''}
                title={item.hint}
                onClick={() => { onTab(item.id); setProjectOpen(false) }}
              >
                {item.label}
              </button>
            ))}
          </AnchoredMenu>
        </div>
        <SheetClose className="browser-close" onClick={onClose} />
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
  const [tab, setTab] = useState<BrowserTab>('sounds')
  return <PlaylistBrowser store={store} engine={engine} phone={phone} tab={tab} onTab={setTab} onClose={onClose} onSeek={onSeek} />
}
