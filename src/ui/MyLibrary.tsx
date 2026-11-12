import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { AnchoredMenu } from './AnchoredMenu'
import { SOUND_MIME } from '../audio/sample/slot'
import { LibraryAuthError, clearLibraryAccessKey, libraryStatus, readLibraryAccessKey, writeLibraryAccessKey } from '../library/access'
import { loadLibraryCatalog } from '../library/audio'
import { browseLibraryRows, type BrowseRow } from '../library/browse'
import { midiName, type LibraryInstrumentSummary } from '../library/group'
import { fetchAllLibraryInstruments } from '../library/instrumentsApi'
import { libraryDragId, loadGroupedLibraryInstrument, loadLibraryDrag, loadLibraryEntry, previewLibraryInstrument, publishLibrary, readLibraryAsset } from '../library/place'
import { libraryRowWindow, searchLibrary, type LibraryIndex } from '../library/search'
import { EMPTY_LIBRARY_QUERY, type LibraryDocument, type LibraryEntry, type LibraryQuery } from '../library/types'
import type { ProjectStore } from '../state/store'

const ROW = 48
const GROUPS = [
  { id: 'type', label: 'Type' },
  { id: 'category', label: 'Category' },
  { id: 'instrument', label: 'Instrument' },
  { id: 'genre', label: 'Genre' },
  { id: 'key', label: 'Key' },
  { id: 'bpm', label: 'BPM' },
  { id: 'mood', label: 'Mood' },
  { id: 'pack', label: 'Pack' },
] as const

type Group = (typeof GROUPS)[number]['id']

const BPM_PRESETS: { id: string; label: string; min: number | null; max: number | null }[] = [
  { id: 'any', label: 'Any BPM', min: null, max: null },
  { id: 'slow', label: '60–90', min: 60, max: 90 },
  { id: 'mid', label: '90–120', min: 90, max: 120 },
  { id: 'up', label: '120–150', min: 120, max: 150 },
  { id: 'fast', label: '150+', min: 150, max: null },
]

const TYPE_LABEL: Record<string, string> = {
  instrument: 'Instruments',
  'one-shot': 'One-shot',
  loop: 'Loop',
  sfx: 'SFX',
}

type Engine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number, loop?: boolean) => void
  currentTimelineSample: () => number
  decodeLibrary?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>
}

let dragId = ''

function decodeOf(engine: Engine) {
  return engine.decodeLibrary ? (bytes: ArrayBuffer) => engine.decodeLibrary!(bytes) : undefined
}

function chipLabel(value: string) {
  return TYPE_LABEL[value] ?? value.charAt(0).toUpperCase() + value.slice(1)
}

function scrollParent(node: HTMLElement) {
  const own = getComputedStyle(node).overflowY
  if (own === 'auto' || own === 'scroll') return node
  let el: HTMLElement | null = node.parentElement
  while (el && el !== document.body && el !== document.documentElement) {
    const overflow = getComputedStyle(el).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return el
    el = el.parentElement
  }
  return node
}

export function MyLibrary({ store, engine }: { store: ProjectStore; engine: Engine }) {
  const [phase, setPhase] = useState<'check' | 'off' | 'lock' | 'load' | 'ready'>('check')
  const [message, setMessage] = useState('Checking the library…')
  const [passphrase, setPassphrase] = useState('')
  const [index, setIndex] = useState<LibraryIndex | null>(null)
  const [instruments, setInstruments] = useState<LibraryInstrumentSummary[]>([])
  const [text, setText] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [group, setGroup] = useState<Group>('type')
  const [query, setQuery] = useState<LibraryQuery>(EMPTY_LIBRARY_QUERY)
  const [busy, setBusy] = useState('')
  const [playing, setPlaying] = useState('')
  const [range, setRange] = useState({ start: 0, end: 16 })
  const listRef = useRef<HTMLDivElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const previewGen = useRef(0)

  function apply(loaded: { document: LibraryDocument; index: LibraryIndex }) {
    publishLibrary(loaded.index.entries.filter((entry) => entry.type !== 'multisample note'))
    setIndex(loaded.index)
    setPhase('ready')
    void fetchAllLibraryInstruments().then(setInstruments).catch(() => setInstruments([]))
  }

  async function openCatalog() {
    setPhase('load')
    setMessage('Loading the library…')
    try {
      const loaded = await loadLibraryCatalog(fetch, undefined, apply)
      apply(loaded)
    } catch (error) {
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      setPhase('off')
      setMessage(error instanceof Error ? error.message : 'My Library is not set up on this server.')
    }
  }

  useEffect(() => {
    let alive = true
    void libraryStatus().then((status) => {
      if (!alive) return
      if (!status.ready) {
        setPhase('off')
        setMessage(status.message)
        return
      }
      if (!readLibraryAccessKey()) {
        setPhase('lock')
        setMessage('Enter the library passphrase. It stays on this phone.')
        return
      }
      void openCatalog()
    })
    return () => { alive = false }
  }, [])

  useEffect(() => () => {
    previewGen.current += 1
    engine.stopPreview()
  }, [engine])

  useEffect(() => {
    const allow = (event: DragEvent) => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes(SOUND_MIME) && !dragId.startsWith('library:')) return
      event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const id = event.dataTransfer?.getData(SOUND_MIME) || dragId
      if (!id.startsWith('library:')) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.my-library, [data-pads]')) return
      event.preventDefault()
      dragId = ''
      engine.unlock()
      void loadLibraryDrag(store, id, engine.currentTimelineSample()).then((ok) => {
        if (ok) store.toast('Library sound loaded.', 'good')
      }).catch((error: unknown) => {
        store.toast(error instanceof Error ? error.message : 'Could not load that sound.', 'warn')
      })
    }
    window.addEventListener('dragover', allow)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', allow)
      window.removeEventListener('drop', drop)
    }
  }, [engine, store])

  const rows = useMemo<BrowseRow[]>(() => {
    if (!index) return []
    const next = { ...query, text }
    return browseLibraryRows(index, searchLibrary(index, next), instruments, next)
  }, [index, instruments, query, text])

  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const scroller = scrollParent(node)
    const update = () => {
      const listIsScroller = scroller === node
      const scrolled = listIsScroller
        ? scroller.scrollTop
        : Math.max(0, scroller.getBoundingClientRect().top - node.getBoundingClientRect().top)
      const viewHeight = Math.min(scroller.clientHeight || window.innerHeight, window.innerHeight || scroller.clientHeight)
      const next = libraryRowWindow(rows.length, scrolled, viewHeight, ROW)
      setRange((prev) => prev.start === next.start && prev.end === next.end ? prev : next)
    }
    node.scrollTop = 0
    if (scroller !== node) scroller.scrollTop = 0
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    node.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', update)
      node.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [rows.length, phase, text, query])

  async function unlock(event: React.FormEvent) {
    event.preventDefault()
    const next = passphrase.trim()
    if (!next) return
    writeLibraryAccessKey(next)
    setPassphrase('')
    await openCatalog()
  }

  function lock() {
    previewGen.current += 1
    engine.stopPreview()
    clearLibraryAccessKey()
    setIndex(null)
    setInstruments([])
    publishLibrary([])
    setPhase('lock')
    setMessage('Enter the library passphrase. It stays on this phone.')
  }

  async function preview(key: string) {
    const entry = index?.entries.find((item) => item.key === key)
    if (!entry) return
    if (playing === key) {
      previewGen.current += 1
      engine.stopPreview()
      setPlaying('')
      return
    }
    const gen = ++previewGen.current
    setBusy(key)
    try {
      engine.unlock()
      const asset = await readLibraryAsset(entry, decodeOf(engine))
      if (gen !== previewGen.current) return
      engine.stopPreview()
      engine.previewPcm(asset.channels, asset.sampleRate, entry.type === 'loop')
      setPlaying(key)
    } catch (error) {
      if (gen !== previewGen.current) return
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      store.toast(error instanceof Error ? error.message : 'Could not play that sound.', 'warn')
    } finally {
      if (gen === previewGen.current) setBusy('')
    }
  }

  async function load(key: string) {
    const entry = index?.entries.find((item) => item.key === key)
    if (!entry) return
    setBusy(key)
    try {
      engine.unlock()
      const note = await loadLibraryEntry(store, entry, engine.currentTimelineSample(), decodeOf(engine))
      store.toast(note, 'good')
    } catch (error) {
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      store.toast(error instanceof Error ? error.message : 'Could not load that sound.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function previewInstrument(item: LibraryInstrumentSummary) {
    if (playing === item.id) {
      previewGen.current += 1
      engine.stopPreview()
      setPlaying('')
      return
    }
    const gen = ++previewGen.current
    setBusy(item.id)
    try {
      engine.unlock()
      const decoded = await previewLibraryInstrument(item, decodeOf(engine))
      if (gen !== previewGen.current) return
      engine.stopPreview()
      engine.previewPcm(decoded.channels, decoded.sampleRate, false)
      setPlaying(item.id)
    } catch (error) {
      if (gen !== previewGen.current) return
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      store.toast(error instanceof Error ? error.message : 'Could not play that instrument.', 'warn')
    } finally {
      if (gen === previewGen.current) setBusy('')
    }
  }

  async function loadInstrument(item: LibraryInstrumentSummary) {
    setBusy(item.id)
    try {
      engine.unlock()
      const note = await loadGroupedLibraryInstrument(store, item.id)
      store.toast(note, 'good')
    } catch (error) {
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      store.toast(error instanceof Error ? error.message : 'Could not load that instrument.', 'warn')
    } finally {
      setBusy('')
    }
  }

  function beginDrag(entry: LibraryEntry, event: ReactDragEvent) {
    dragId = libraryDragId(entry)
    event.dataTransfer.setData(SOUND_MIME, dragId)
    event.dataTransfer.setData('text/plain', entry.name)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const facets = index?.facets
  const values = facetValues(group, facets, instruments.length > 0)
  const active = activeFilters(query)
  const shown = rows.slice(range.start, range.end)
  const instrumentCount = rows.filter((row) => row.kind === 'instrument').length
  const soundCount = rows.length - instrumentCount
  const countLabel = rows.length === 0
    ? '0 sounds'
    : instrumentCount && soundCount
      ? `${instrumentCount === 1 ? '1 instrument' : `${instrumentCount} instruments`} · ${soundCount === 1 ? '1 sound' : `${soundCount} sounds`}`
      : instrumentCount
        ? (instrumentCount === 1 ? '1 instrument' : `${instrumentCount} instruments`)
        : (soundCount === 1 ? '1 sound' : `${soundCount} sounds`)

  return (
    <div className="sound-panel my-library" data-library-panel="open" aria-label="My Library. Private sounds from your library.">
      {phase === 'off' && <p className="sound-status">{message}</p>}
      {phase === 'check' && <p className="sound-status">{message}</p>}
      {phase === 'lock' && (
        <form className="library-lock" onSubmit={(event) => void unlock(event)}>
          <p className="sound-status">{message}</p>
          <input
            type="password"
            aria-label="Library passphrase"
            autoComplete="current-password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <button type="submit" className="sound-add">Unlock</button>
        </form>
      )}
      {phase === 'load' && <p className="sound-status">{message}</p>}
      {phase === 'ready' && index && (
        <>
          <div className="sound-filters library-search">
            <input aria-label="Search my library" placeholder="Search" value={text} onChange={(event) => setText(event.target.value)} />
            <button
              ref={filterButton}
              type="button"
              className={`sound-filter library-filter-btn${active.length ? ' on' : ''}`}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              aria-label={active.length ? `Filter. ${active.length} active.` : 'Filter'}
              title="Type, category, instrument, genre, key, and tempo."
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <FilterIcon />
              {active.length > 0 && <span className="filter-badge">{active.length}</span>}
            </button>
            <AnchoredMenu className="sound-filter-menu library-filter-sheet" open={filtersOpen} onClose={() => setFiltersOpen(false)} label="Filter" triggerRef={filterButton}>
              <div className="sound-chips library-chip-scroll" role="group" aria-label="Filter groups">
                {GROUPS.map((item) => (
                  <button key={item.id} type="button" className={`filter-choice${group === item.id || groupActive(item.id, query) ? ' on' : ''}`} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>
                ))}
              </div>
              <div className="sound-chips library-chip-scroll" role="group" aria-label={`${chipLabel(group)} filters`}>
                {group === 'bpm' ? BPM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`filter-choice${query.bpmMin === preset.min && query.bpmMax === preset.max ? ' on' : ''}`}
                    aria-pressed={query.bpmMin === preset.min && query.bpmMax === preset.max}
                    onClick={() => setQuery((current) => ({ ...current, bpmMin: preset.min, bpmMax: preset.max }))}
                  >
                    {preset.label}
                  </button>
                )) : (
                  <>
                    <button type="button" className={`filter-choice${!selectedValue(group, query) ? ' on' : ''}`} aria-pressed={!selectedValue(group, query)} onClick={() => setQuery((current) => ({ ...current, ...cleared(group) }))}>Any</button>
                    {values.map((value) => (
                      <button key={value} type="button" className={`filter-choice${selectedValue(group, query) === value ? ' on' : ''}`} aria-pressed={selectedValue(group, query) === value} onClick={() => setQuery((current) => ({ ...current, ...picked(group, value) }))}>{chipLabel(value)}</button>
                    ))}
                  </>
                )}
              </div>
              {group === 'bpm' && (
                <div className="bpm-range">
                  <input aria-label="Minimum BPM" inputMode="numeric" placeholder="Min" value={query.bpmMin ?? ''} onChange={(event) => setQuery((current) => ({ ...current, bpmMin: readBpm(event.target.value) }))} />
                  <input aria-label="Maximum BPM" inputMode="numeric" placeholder="Max" value={query.bpmMax ?? ''} onChange={(event) => setQuery((current) => ({ ...current, bpmMax: readBpm(event.target.value) }))} />
                </div>
              )}
              <button type="button" className="filter-choice" onClick={lock}>Lock library</button>
            </AnchoredMenu>
          </div>
          {active.length > 0 && (
            <div className="sound-chips library-chip-scroll library-active" role="group" aria-label="Active filters">
              {active.map((item) => (
                <button key={item.id} type="button" className="on" aria-label={`Clear ${item.label}`} onClick={() => setQuery((current) => ({ ...current, ...item.clear }))}>{item.label} ×</button>
              ))}
            </div>
          )}
          <p className="sound-count library-count" data-library-count={rows.length}>{countLabel}</p>
          <div className="sound-list" ref={listRef} aria-label="Library sounds">
            {rows.length === 0 && <p className="sound-status">Nothing matches.</p>}
            {rows.length > 0 && (
              <div style={{ height: rows.length * ROW, position: 'relative', width: '100%', maxWidth: '100%' }}>
                <div style={{ position: 'absolute', top: range.start * ROW, left: 0, right: 0, maxWidth: '100%' }}>
                  {shown.map((row) => row.kind === 'instrument' ? (
                    <InstrumentRow
                      key={row.instrument.id}
                      item={row.instrument}
                      playing={playing === row.instrument.id}
                      busy={busy === row.instrument.id}
                      onPlay={() => void previewInstrument(row.instrument)}
                      onLoad={() => { engine.unlock(); void loadInstrument(row.instrument) }}
                    />
                  ) : (
                    <SoundRow
                      key={row.entry.key}
                      entry={row.entry}
                      playing={playing === row.entry.key}
                      busy={busy === row.entry.key}
                      onPlay={() => void preview(row.entry.key)}
                      onLoad={() => { engine.unlock(); void load(row.entry.key) }}
                      onDrag={(event) => beginDrag(row.entry, event)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function InstrumentRow({
  item,
  playing,
  busy,
  onPlay,
  onLoad,
}: {
  item: LibraryInstrumentSummary
  playing: boolean
  busy: boolean
  onPlay: () => void
  onLoad: () => void
}) {
  const span = item.notes <= 1 ? midiName(item.previewMidi) : `${midiName(item.lo)}–${midiName(item.hi)}`
  const meta = busy ? 'Loading' : playing ? 'Playing' : [item.category || 'Instrument', span].filter(Boolean).join(' · ')
  return (
    <div className={`sound-row${playing ? ' is-playing' : ''}`} data-library-instrument={item.id}>
      <button type="button" className="sound-copy" aria-label={playing ? `Stop ${item.name}` : `Play ${item.name}`} onClick={onPlay}>
        <strong>{item.name}</strong>
        <span className="sound-meta">{busy ? 'Loading' : meta}</span>
      </button>
      <button type="button" className="sound-add" aria-label={`Load ${item.name}`} disabled={busy} onClick={onLoad}>Load</button>
    </div>
  )
}

function SoundRow({
  entry,
  playing,
  busy,
  onPlay,
  onLoad,
  onDrag,
}: {
  entry: LibraryEntry
  playing: boolean
  busy: boolean
  onPlay: () => void
  onLoad: () => void
  onDrag: (event: ReactDragEvent) => void
}) {
  const meta = busy ? 'Loading' : playing ? 'Playing' : [entry.type ? chipLabel(entry.type) : '', entry.category || entry.musicalKey || (entry.bpm ? `${entry.bpm} bpm` : '')].filter(Boolean).slice(0, 2).join(' · ')
  return (
    <div className={`sound-row${playing ? ' is-playing' : ''}`} data-library-key={entry.key}>
      <button type="button" className="sound-copy" draggable aria-label={playing ? `Stop ${entry.name}` : `Play ${entry.name}`} onDragStart={onDrag} onClick={onPlay}>
        <strong>{entry.name}</strong>
        <span className="sound-meta">{busy ? 'Loading' : meta}</span>
      </button>
      <button type="button" className="sound-add" aria-label={`Load ${entry.name}`} disabled={busy} onClick={onLoad}>Load</button>
    </div>
  )
}

function FilterIcon() {
  return (
    <svg className="filter-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function readBpm(value: string) {
  if (!value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function facetValues(group: Group, facets: LibraryIndex['facets'] | undefined, hasInstruments: boolean) {
  const values = facets ? valuesFor(group, facets).filter((value) => value !== 'multisample note') : []
  if (group === 'type' && hasInstruments && !values.includes('instrument')) return ['instrument', ...values]
  return values
}

function valuesFor(group: Group, facets: LibraryIndex['facets']) {
  if (group === 'type') return facets.types
  if (group === 'category') return facets.categories
  if (group === 'instrument') return facets.instruments
  if (group === 'genre') return facets.genres
  if (group === 'key') return facets.keys
  if (group === 'mood') return facets.moods
  if (group === 'pack') return facets.packs
  return []
}

function selectedValue(group: Group, query: LibraryQuery) {
  if (group === 'type') return query.type
  if (group === 'category') return query.category
  if (group === 'instrument') return query.instrument
  if (group === 'genre') return query.genre
  if (group === 'key') return query.musicalKey
  if (group === 'mood') return query.mood
  if (group === 'pack') return query.pack
  return ''
}

function cleared(group: Group): Partial<LibraryQuery> {
  if (group === 'type') return { type: '' }
  if (group === 'category') return { category: '' }
  if (group === 'instrument') return { instrument: '' }
  if (group === 'genre') return { genre: '' }
  if (group === 'key') return { musicalKey: '' }
  if (group === 'mood') return { mood: '' }
  if (group === 'pack') return { pack: '' }
  return { bpmMin: null, bpmMax: null }
}

function picked(group: Group, value: string): Partial<LibraryQuery> {
  return { ...cleared(group), ...valuePatch(group, value) }
}

function valuePatch(group: Group, value: string): Partial<LibraryQuery> {
  if (group === 'type') return { type: value }
  if (group === 'category') return { category: value }
  if (group === 'instrument') return { instrument: value }
  if (group === 'genre') return { genre: value }
  if (group === 'key') return { musicalKey: value }
  if (group === 'mood') return { mood: value }
  if (group === 'pack') return { pack: value }
  return {}
}

function groupActive(group: Group, query: LibraryQuery) {
  if (group === 'bpm') return query.bpmMin != null || query.bpmMax != null
  return Boolean(selectedValue(group, query))
}

function activeFilters(query: LibraryQuery) {
  const rows: { id: string; label: string; clear: Partial<LibraryQuery> }[] = []
  if (query.type) rows.push({ id: 'type', label: chipLabel(query.type), clear: { type: '' } })
  if (query.category) rows.push({ id: 'category', label: chipLabel(query.category), clear: { category: '' } })
  if (query.instrument) rows.push({ id: 'instrument', label: chipLabel(query.instrument), clear: { instrument: '' } })
  if (query.genre) rows.push({ id: 'genre', label: chipLabel(query.genre), clear: { genre: '' } })
  if (query.musicalKey) rows.push({ id: 'key', label: query.musicalKey, clear: { musicalKey: '' } })
  if (query.mood) rows.push({ id: 'mood', label: chipLabel(query.mood), clear: { mood: '' } })
  if (query.pack) rows.push({ id: 'pack', label: query.pack, clear: { pack: '' } })
  if (query.bpmMin != null || query.bpmMax != null) {
    const label = query.bpmMin != null && query.bpmMax != null ? `${query.bpmMin}–${query.bpmMax} bpm` : query.bpmMin != null ? `${query.bpmMin}+ bpm` : `Under ${query.bpmMax} bpm`
    rows.push({ id: 'bpm', label, clear: { bpmMin: null, bpmMax: null } })
  }
  return rows
}
