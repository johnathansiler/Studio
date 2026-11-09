import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent } from 'react'
import { soundCache } from '../sounds/cache'
import { decodeSoundBytes, trackIdFromDrop } from '../sounds/place'
import { filterHarborLoops, loopInstruments, loopKeys } from '../harbor/filter'
import { normalizePeak } from '../audio/level'
import { sampleLoadFault, sampleLoadState, subscribeSampleLoad } from '../audio/sampleLoadBus'
import { instrumentFileUrl, loadHarborCatalog, loadZoneSamples, prepareCatalogInstrument, rememberHarborCatalog, samplesForNote } from '../harbor/load'
import { installHarborInstrument } from '../harbor/player'
import { placeHarborLoop, previewHarborLoop } from '../harbor/place'
import { articulationsIn } from '../harbor/program'
import { licenseLabel } from '../harbor/license'
import { INSTRUMENT_FAMILIES, type CatalogInstrument, type HarborCatalog, type HarborEntry, type LoopKind } from '../harbor/types'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'
import { HarborPresetBar, HarborProgress } from './HarborPresets'
import './harbor-browser.css'

const HARBOR_MIME = 'application/x-cueharbor-harbor'
let dragId = ''

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number, loop?: boolean) => void
  currentTimelineSample: () => number
  holdLibraryAudio?: (trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) => void
  auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
}

function revealClip(trackId: string, clipId: string) {
  const show = () => {
    const clip = document.querySelector(`[data-clip="${CSS.escape(clipId)}"]`) as HTMLElement | null
    const timeline = document.querySelector('.timeline-scroll') as HTMLElement | null
    if (!timeline || !clip || clip.getAttribute('data-track') !== trackId) return false
    const view = timeline.getBoundingClientRect()
    const box = clip.getBoundingClientRect()
    if (box.top < view.top + 12 || box.bottom > view.bottom - 12) timeline.scrollTop += box.top - view.top - 12
    if (box.left < view.left + 12 || box.right > view.right - 12) timeline.scrollLeft += box.left - view.left - 12
    return true
  }
  requestAnimationFrame(() => {
    if (!show()) requestAnimationFrame(show)
  })
}

export function HarborBrowser({
  store,
  engine,
  section,
  initial,
}: {
  store: ProjectStore
  engine: PreviewEngine
  section: 'instruments' | 'loops'
  /** Tests pass a catalog so the panel can render without the network. */
  initial?: HarborCatalog
}) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const [catalog, setCatalog] = useState<HarborCatalog>(initial ?? { version: '', instruments: [], loops: [], entries: [] })
  const [loading, setLoading] = useState(!initial)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [bpm, setBpm] = useState<'any' | 'project'>('any')
  const [soundKey, setSoundKey] = useState('')
  const [kind, setKind] = useState<'any' | LoopKind>('any')
  const [instrument, setInstrument] = useState('')
  const [matchKey, setMatchKey] = useState(true)
  const [filterOpen, setFilterOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [playing, setPlaying] = useState('')
  const [fault, setFault] = useState('')
  const sampleLoad = useSyncExternalStore(subscribeSampleLoad, sampleLoadState, sampleLoadState)
  const addRef = useRef<(entry: HarborEntry, trackId?: string | null, startSample?: number) => void>(() => undefined)
  const entriesRef = useRef(catalog.loops)
  const filterButton = useRef<HTMLButtonElement>(null)
  entriesRef.current = catalog.loops

  useEffect(() => {
    if (initial) {
      rememberHarborCatalog(initial)
      return
    }
    let alive = true
    setLoading(true)
    void loadHarborCatalog(fetch, soundCache()).then((next) => {
      if (!alive) return
      setCatalog(next)
      setFailed(!next.instruments.length && !next.loops.length)
      setLoading(false)
    }).catch(() => {
      if (!alive) return
      setCatalog({ version: '', instruments: [], loops: [], entries: [] })
      setFailed(true)
      setLoading(false)
    })
    return () => { alive = false }
  }, [initial])

  useEffect(() => () => engine.stopPreview(), [engine])

  useEffect(() => {
    const allow = (event: DragEvent) => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes(HARBOR_MIME) && !dragId) return
      event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const id = event.dataTransfer?.getData(HARBOR_MIME) || dragId
      if (!id.startsWith('loop:')) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.harbor-browser, .playlist-browser')) return
      event.preventDefault()
      dragId = ''
      const entry = entriesRef.current.find((item) => item.id === id.slice(5))
      if (entry) void addRef.current(entry, trackIdFromDrop(target), engine.currentTimelineSample())
    }
    window.addEventListener('dragover', allow)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', allow)
      window.removeEventListener('drop', drop)
    }
  }, [engine, store])

  const instruments = catalog.instruments
  const loops = catalog.loops
  const needle = text.trim().toLowerCase()
  const shownInstruments = instruments.filter((item) => {
    if (!needle) return true
    const hay = `${item.name} ${item.family} ${item.category ?? ''} ${item.tags.join(' ')}`.toLowerCase()
    return needle.split(/\s+/).every((token) => hay.includes(token))
  })
  const shownLoops = filterHarborLoops(loops, {
    text,
    bpm,
    key: soundKey,
    kind,
    instrument,
    projectBpm: store.project.tempo,
  })
  const keys = loopKeys(loops)
  const names = loopInstruments(loops)
  const selected = store.project.tracks.find((track) => track.id === store.selectedTrackId) ?? null
  const where = section === 'instruments'
    ? (selected?.type === 'midi' ? `Loads onto ${selected.name}.` : 'Loads onto a new instrument track.')
    : (selected?.type === 'audio' ? `Adds to ${selected.name} at the playhead.` : 'Adds on a new audio track at the playhead.')

  function midiTarget(trackId?: string | null) {
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'midi') return dropped.id
    if (trackId) return null
    if (selected?.type === 'midi') return selected.id
    const ids = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    return ids[0] ?? null
  }

  function audioTarget(trackId?: string | null) {
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'audio') return dropped.id
    if (trackId) return null
    if (selected?.type === 'audio') return selected.id
    return null
  }

  async function loadInstrument(item: CatalogInstrument, trackId?: string | null) {
    if (store.remoteFollow) {
      store.toast('The host owns the arrangement.', 'warn')
      return
    }
    const target = midiTarget(trackId)
    if (!target) {
      store.toast('Instruments load onto an instrument track.', 'warn')
      return
    }
    setBusy(item.id)
    setFault('')
    sampleLoadFault('')
    try {
      engine.unlock()
      const program = await prepareCatalogInstrument(item)
      if (!program) throw new Error(`${item.name} has no playable notes.`)
      await installHarborInstrument({
        id: `harbor:${item.id}`,
        name: item.name,
        family: item.family,
        license: item.license,
        label: licenseLabel(item.license),
        source: item.source ?? '',
        articulations: articulationsIn(program),
        zones: [],
        program,
      }, target, {
        setLibrary: (id, program) => store.setLibrary(id, program),
        holdLibraryAudio: engine.holdLibraryAudio ? (id, samples) => engine.holdLibraryAudio!(id, samples) : undefined,
        auditionLibrary: engine.auditionLibrary ? (id, pitch, velocity) => engine.auditionLibrary!(id, pitch, velocity) : undefined,
      }, { cache: soundCache() })
      store.toast(`${item.name} is on the keyboard.`, 'good')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load that instrument.'
      setFault(message)
      sampleLoadFault(message)
      store.toast(message, 'warn')
    } finally {
      setBusy('')
    }
  }

  /** Play middle C on the speakers. Does not open the instrument editor. */
  async function previewInstrument(item: CatalogInstrument) {
    if (playing === item.id) {
      engine.stopPreview()
      setPlaying('')
      return
    }
    setBusy(item.id)
    setFault('')
    sampleLoadFault('')
    try {
      engine.unlock()
      const program = await prepareCatalogInstrument(item)
      if (!program) throw new Error(`${item.name} has no playable notes.`)
      const decoded = await loadZoneSamples(samplesForNote(program, 60, 0.9))
      const first = decoded.find((sample) => sample.channels.some((channel) => channel.length > 0))
      if (!first) throw new Error(`${item.name} did not load a preview.`)
      engine.stopPreview()
      engine.previewPcm(normalizePeak(first.channels), first.sampleRate, false)
      setPlaying(item.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not preview that instrument.'
      setFault(message)
      sampleLoadFault(message)
      store.toast(message, 'warn')
    } finally {
      setBusy('')
    }
  }

  async function readLoop(entry: HarborEntry) {
    const url = instrumentFileUrl(entry.path)
    const hit = await soundCache().get(url)
    let bytes = hit
    if (!bytes) {
      const response = await fetch(url)
      if (!response.ok) throw new Error('Could not download that loop.')
      bytes = await response.arrayBuffer()
      try { await soundCache().put(url, bytes) } catch { /* the preview still plays */ }
    }
    return decodeSoundBytes(bytes)
  }

  async function addLoop(entry: HarborEntry, trackId?: string | null, startSample?: number) {
    if (store.remoteFollow) {
      store.toast('The host owns the arrangement.', 'warn')
      return
    }
    setBusy(entry.id)
    try {
      const decoded = await readLoop(entry)
      const placed = placeHarborLoop({
        entry,
        channels: decoded.channels,
        fileRate: decoded.sampleRate,
        project: store.project,
        startSample: 0,
        matchKey,
      })
      if (!placed) {
        store.toast('That loop had no audio.', 'warn')
        return
      }
      if (!store.buffers.has(placed.asset.id)) store.addAsset(placed.asset)
      const landed = store.placeClipAtPlayhead(audioTarget(trackId), placed.clip, startSample ?? engine.currentTimelineSample())
      if (!landed) {
        store.toast('Could not add that loop onto the track.', 'warn')
        return
      }
      revealClip(landed.trackId, landed.clipId)
      const pitched = (placed.clip.stretch?.semitones ?? 0) !== 0
      store.toast(pitched ? `${entry.name} follows the song tempo and key.` : `${entry.name} follows the song tempo.`, 'good')
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not add that loop.', 'warn')
    } finally {
      setBusy('')
    }
  }
  addRef.current = (entry, trackId, startSample) => { void addLoop(entry, trackId, startSample) }

  async function preview(entry: HarborEntry) {
    if (playing === entry.id) {
      engine.stopPreview()
      setPlaying('')
      return
    }
    setBusy(entry.id)
    try {
      const decoded = await readLoop(entry)
      const channels = previewHarborLoop({
        entry,
        channels: decoded.channels,
        fileRate: decoded.sampleRate,
        project: store.project,
        startSample: engine.currentTimelineSample(),
        matchKey,
      })
      if (!channels?.[0]?.length) {
        store.toast('That loop had no audio.', 'warn')
        return
      }
      engine.unlock()
      engine.stopPreview()
      engine.previewPcm(channels, store.project.sampleRate, true)
      setPlaying(entry.id)
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not play that loop.', 'warn')
    } finally {
      setBusy('')
    }
  }

  function onDragStart(event: ReactDragEvent, entry: HarborEntry) {
    dragId = `loop:${entry.id}`
    event.dataTransfer.setData(HARBOR_MIME, dragId)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const summary = [
    bpm === 'project' ? 'Song tempo' : '',
    soundKey,
    kind === 'any' ? '' : kind === 'drum' ? 'Drum' : 'Melodic',
    instrument,
    matchKey ? 'Song key' : '',
  ].filter(Boolean).join(', ')
  const empty = section === 'instruments' ? shownInstruments.length === 0 : shownLoops.length === 0
  const message = loading
    ? 'Loading'
    : failed && !catalog.instruments.length && !catalog.loops.length
      ? 'The instrument library is not online yet.'
      : empty
        ? 'Nothing matches those filters.'
        : ''

  return (
    <div className="sound-panel harbor-browser" data-harbor={section} aria-label={section === 'instruments' ? 'Instruments' : 'Loops'}>
      <p className="sound-where">{where}</p>
      <div className="sound-filters">
        <input aria-label={section === 'instruments' ? 'Search instruments' : 'Search loops'} placeholder="Search" value={text} onChange={(event) => setText(event.target.value)} />
        {section === 'loops' && (
          <>
            <button
              ref={filterButton}
              type="button"
              className={`sound-filter${summary ? ' on' : ''}`}
              aria-expanded={filterOpen}
              aria-haspopup="menu"
              aria-label={summary ? `Filter. ${summary}.` : 'Filter. Tempo, key, type, and instrument.'}
              title="Tempo, key, type, and instrument."
              onClick={() => setFilterOpen((value) => !value)}
            >
              Filter
            </button>
            <AnchoredMenu className="sound-filter-menu harbor-menu" open={filterOpen} onClose={() => setFilterOpen(false)} label="Filter" triggerRef={filterButton}>
              <p className="filter-label">Tempo</p>
              <div className="filter-row" role="group" aria-label="Tempo">
                <button type="button" className={`filter-choice${bpm === 'any' ? ' on' : ''}`} aria-pressed={bpm === 'any'} onClick={() => setBpm('any')}>Any tempo</button>
                <button type="button" className={`filter-choice${bpm === 'project' ? ' on' : ''}`} aria-pressed={bpm === 'project'} onClick={() => setBpm('project')}>Song tempo</button>
              </div>
              <p className="filter-label">Key</p>
              <div className="filter-row" role="group" aria-label="Key">
                <button type="button" className={`filter-choice${!soundKey ? ' on' : ''}`} aria-pressed={!soundKey} onClick={() => setSoundKey('')}>Any key</button>
                {keys.map((item) => (
                  <button key={item} type="button" className={`filter-choice${soundKey === item ? ' on' : ''}`} aria-pressed={soundKey === item} onClick={() => setSoundKey(item)}>{item}</button>
                ))}
              </div>
              <p className="filter-label">Type</p>
              <div className="filter-row" role="group" aria-label="Type. Drum or melodic loops.">
                <button type="button" className={`filter-choice${kind === 'any' ? ' on' : ''}`} aria-pressed={kind === 'any'} onClick={() => setKind('any')}>Any type</button>
                <button type="button" className={`filter-choice${kind === 'drum' ? ' on' : ''}`} aria-pressed={kind === 'drum'} onClick={() => setKind('drum')}>Drum</button>
                <button type="button" className={`filter-choice${kind === 'melodic' ? ' on' : ''}`} aria-pressed={kind === 'melodic'} onClick={() => setKind('melodic')}>Melodic</button>
              </div>
              <p className="filter-label">Instrument</p>
              <div className="filter-row" role="group" aria-label="Instrument">
                <button type="button" className={`filter-choice${!instrument ? ' on' : ''}`} aria-pressed={!instrument} onClick={() => setInstrument('')}>Any instrument</button>
                {names.map((item) => (
                  <button key={item} type="button" className={`filter-choice${instrument === item ? ' on' : ''}`} aria-pressed={instrument === item} onClick={() => setInstrument(item)}>{item}</button>
                ))}
              </div>
              <p className="filter-label">Pitch</p>
              <div className="filter-row">
                <button type="button" className={`filter-choice${matchKey ? ' on' : ''}`} aria-pressed={matchKey} title="Pitch melodic loops to the project key. Drum loops stay put." onClick={() => setMatchKey((value) => !value)}>Song key</button>
              </div>
            </AnchoredMenu>
          </>
        )}
      </div>
      {section === 'instruments' && selected?.type === 'midi' && <HarborPresetBar store={store} trackId={selected.id} />}
      <HarborProgress />
      {message && <p className="sound-status">{message}</p>}
      {fault && <p className="sound-status" role="alert">{fault}</p>}
      <div className="harbor-list sound-list">
        {section === 'instruments' && INSTRUMENT_FAMILIES.map((family) => {
          const rows = shownInstruments.filter((item) => item.family === family)
          if (!rows.length) return null
          return (
            <section key={family} data-family={family}>
              <h3 className="harbor-family">{family}</h3>
              {rows.map((item) => {
                const meta = busy === item.id
                  ? `Loading ${Math.round((sampleLoad.ratio || 0) * 100)}%`
                  : playing === item.id
                    ? 'Playing'
                    : `${licenseLabel(item.license)}${item.category ? ` · ${item.category}` : ''}`
                return (
                <div key={item.id} className={`sound-row${playing === item.id || busy === item.id ? ' is-playing' : ''}`}>
                  <button type="button" className="sound-copy" title={`${item.name}. Preview middle C.`} onClick={() => void previewInstrument(item)}>
                    <strong>{item.name}</strong>
                    <span className="sound-meta">{meta}</span>
                  </button>
                  <button type="button" className="sound-add" disabled={busy === item.id} aria-label={`Load ${item.name}`} title={where} onClick={() => void loadInstrument(item)}>Load</button>
                </div>
                )
              })}
            </section>
          )
        })}
        {section === 'loops' && shownLoops.map((entry) => (
          <div key={entry.id} className={`sound-row${playing === entry.id ? ' is-playing' : ''}`}>
            <button
              type="button"
              className="sound-copy"
              draggable
              title="Play this loop at the song tempo. Drag it onto the playlist, or use Add."
              onDragStart={(event) => onDragStart(event, entry)}
              onDragEnd={() => { dragId = '' }}
              onClick={() => void preview(entry)}
            >
              <strong>{entry.name}</strong>
              <span className="sound-meta">
                {[entry.bpm ? `${Math.round(entry.bpm)} bpm` : '', entry.key ?? '', entry.bars ? `${entry.bars} bars` : '', entry.loopKind === 'drum' ? 'Drum' : 'Melodic', licenseLabel(entry.license)].filter(Boolean).join(' · ')}
              </span>
            </button>
            <button type="button" className="sound-add" disabled={busy === entry.id} onClick={() => void addLoop(entry)}>Add</button>
          </div>
        ))}
      </div>
    </div>
  )
}
