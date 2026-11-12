import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import { AnchoredMenu } from './AnchoredMenu'
import { SOUND_MIME } from '../audio/sample/slot'
import { LibraryAuthError, clearLibraryAccessKey, libraryStatus, readLibraryAccessKey, writeLibraryAccessKey } from '../library/access'
import { loadLibraryCatalog } from '../library/audio'
import { browseLibraryRows, type BrowseRow } from '../library/browse'
import { browseIndexForId, browseRowId, readBrowsePlace, scrollTopForIndex, writeBrowsePlace } from './browsePlace'
import { clearRecent, recentSounds, subscribeRecent } from '../library/recent'
import { absorbLegacyFavoriteIds, favoriteSounds, isFavorite, subscribeFavorites, toggleFavorite } from '../library/favorites'
import { FavoriteStar } from './FavoriteStar'
import { groupLibraryInstruments, midiName, summarizeInstrument, type LibraryInstrument, type LibraryInstrumentSummary } from '../library/group'
import { fetchAllLibraryInstruments } from '../library/instrumentsApi'
import { libraryDragId, loadGroupedLibraryInstrument, loadLibraryDrag, loadLibraryEntry, placeLibraryInstrument, previewLibraryInstrument, publishLibrary, readLibraryAsset } from '../library/place'
import { retargetLibraryMemory } from '../library/retarget'
import { libraryRowWindow, searchLibrary, type LibraryIndex } from '../library/search'
import type { LibraryDocument, LibraryEntry, LibraryQuery } from '../library/types'
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

function filterAnchor() {
  if (typeof document === 'undefined') return null
  const button = document.querySelector('.my-library .library-filter-btn')
  const panel = button?.closest('[data-playlist-browser="open"]')
  if (!(button instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null
  const buttonBox = button.getBoundingClientRect()
  const panelBox = panel.getBoundingClientRect()
  return { left: panelBox.left, top: buttonBox.top, width: panelBox.width, height: buttonBox.height }
}

function syncFilterSheetWidth() {
  if (typeof document === 'undefined') return
  const panel = document.querySelector('[data-playlist-browser="open"]')
  if (!panel) return
  const raw = panel.getBoundingClientRect().width
  const width = Math.max(240, Math.min(420, raw - 16, window.innerWidth - 16))
  document.documentElement.style.setProperty('--library-filter-width', `${Math.round(width)}px`)
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
  const saved = useRef(readBrowsePlace())
  const [phase, setPhase] = useState<'check' | 'off' | 'lock' | 'load' | 'ready'>('check')
  const [message, setMessage] = useState('Checking the library…')
  const [passphrase, setPassphrase] = useState('')
  const [index, setIndex] = useState<LibraryIndex | null>(null)
  const [instruments, setInstruments] = useState<LibraryInstrumentSummary[]>([])
  const grouped = useRef<LibraryInstrument[]>([])
  const coveredKeys = useRef<Set<string>>(new Set())
  const [text, setText] = useState(saved.current.libraryText)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [group, setGroup] = useState<Group>(saved.current.libraryGroup as Group)
  const [query, setQuery] = useState<LibraryQuery>(saved.current.libraryQuery)
  const [busy, setBusy] = useState('')
  const [playing, setPlaying] = useState('')
  const [focusId, setFocusId] = useState(saved.current.libraryFocus)
  const [quick, setQuick] = useState<'' | 'recent' | 'favorites'>(saved.current.libraryQuick)
  const [range, setRange] = useState({ start: 0, end: 16 })
  const recent = useSyncExternalStore(subscribeRecent, recentSounds, recentSounds)
  const favorites = useSyncExternalStore(subscribeFavorites, favoriteSounds, favoriteSounds)
  const listRef = useRef<HTMLDivElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const previewGen = useRef(0)

  function rememberGroups(entries: LibraryDocument['entries']) {
    const full = groupLibraryInstruments(entries)
    grouped.current = full
    const covered = new Set<string>()
    for (const entry of entries) {
      if (entry.type === 'multisample note') covered.add(entry.key)
    }
    for (const instrument of full) {
      for (const layer of instrument.layers) covered.add(layer.key)
    }
    coveredKeys.current = covered
    setInstruments(full.map(summarizeInstrument))
    retargetLibraryMemory(full)
  }

  function apply(loaded: { document: LibraryDocument; index: LibraryIndex }) {
    rememberGroups(loaded.index.entries)
    publishLibrary(loaded.index.entries.filter((entry) => entry.type !== 'multisample note' && !coveredKeys.current.has(entry.key)))
    setIndex(loaded.index)
    setPhase('ready')
    void fetchAllLibraryInstruments().then((remote) => {
      if (!remote.length) return
      setInstruments((local) => {
        const seen = new Set(local.map((item) => item.id))
        return [...local, ...remote.filter((item) => !seen.has(item.id))]
      })
    }).catch(() => undefined)
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
    const listed = browseLibraryRows(index, searchLibrary(index, next), instruments, next, coveredKeys.current)
    const needle = text.trim().toLowerCase()
    const matches = (name: string) => !needle || name.toLowerCase().includes(needle)
    const picked: BrowseRow[] = []
    const source = quick === 'recent' ? recent : favorites
    if (quick === 'recent' || quick === 'favorites') {
      for (const item of source) {
        if (!matches(item.name) && !matches(('legacyId' in item ? item.legacyId : '') || '')) continue
        if (item.instrument) {
          const live = instruments.find((row) => row.id === item.instrument!.id) ?? item.instrument
          picked.push({ kind: 'instrument', instrument: live })
          continue
        }
        const legacy = 'legacyId' in item ? item.legacyId : ''
        const key = item.library?.key || legacy || item.id.replace(/^(library|catalog|sound|instrument):/, '')
        const groupedHit = grouped.current.find((row) => row.layers.some((layer) => layer.key === key) || row.id === key)
        if (groupedHit) {
          picked.push({ kind: 'instrument', instrument: summarizeInstrument(groupedHit) })
          continue
        }
        const live = index.entries.find((row) => row.key === key) ?? item.library
        if (live) picked.push({ kind: 'sound', entry: live })
      }
      return picked
    }
    return listed
  }, [favorites, index, instruments, query, quick, recent, text])

  const filterKey = `${text}\0${JSON.stringify(query)}`
  const filterKeyRef = useRef(filterKey)
  const didRestore = useRef(false)
  useEffect(() => {
    writeBrowsePlace({ libraryText: text, libraryQuery: query, libraryGroup: group, libraryQuick: quick })
  }, [text, query, group, quick])
  useEffect(() => {
    absorbLegacyFavoriteIds(store.project.soundFavorites ?? [])
  }, [store])

  function keep(id: string) {
    setFocusId(id)
    writeBrowsePlace({ libraryFocus: id, libraryAnchor: id })
  }

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
      const index = Math.min(rows.length - 1, Math.max(0, Math.round(scrolled / ROW)))
      const row = rows[index]
      if (row) writeBrowsePlace({ libraryAnchor: browseRowId(row) })
    }
    const filterChanged = filterKeyRef.current !== filterKey
    filterKeyRef.current = filterKey
    if (filterChanged) {
      scroller.scrollTop = 0
      if (scroller !== node) node.scrollTop = 0
      didRestore.current = true
    } else if (!didRestore.current && rows.length) {
      const place = readBrowsePlace()
      const ids = rows.map(browseRowId)
      const focus = browseIndexForId(ids, place.libraryFocus)
      const anchor = browseIndexForId(ids, place.libraryAnchor)
      const index = focus >= 0 ? focus : anchor
      if (index >= 0) {
        const top = scrollTopForIndex(index, ROW)
        scroller.scrollTop = top
        if (scroller !== node) node.scrollTop = top
        didRestore.current = true
      }
    }
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
  }, [rows, phase, filterKey])

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
    keep(`sound:${key}`)
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
    keep(`sound:${key}`)
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
    keep(`instrument:${item.id}`)
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
    keep(`instrument:${item.id}`)
    setBusy(item.id)
    try {
      engine.unlock()
      const local = grouped.current.find((row) => row.id === item.id)
      const note = local ? placeLibraryInstrument(store, local) : await loadGroupedLibraryInstrument(store, item.id)
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

  if (filtersOpen) syncFilterSheetWidth()

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
            <button type="button" className="sound-filter library-lock-btn" onClick={lock}>Lock</button>
            <AnchoredMenu className="sound-filter-menu library-filter-sheet" open={filtersOpen} onClose={() => setFiltersOpen(false)} label="Filter" triggerRef={filterButton} anchor={filtersOpen ? filterAnchor() : null}>
              <div className="library-filter-grid" role="group" aria-label="Filter groups">
                <button type="button" className={`filter-choice library-quick${quick === 'recent' ? ' on' : ''}`} data-quick="recent" aria-pressed={quick === 'recent'} onClick={() => setQuick((current) => current === 'recent' ? '' : 'recent')}>Recent</button>
                <button type="button" className={`filter-choice library-quick${quick === 'favorites' ? ' on' : ''}`} data-quick="favorites" aria-pressed={quick === 'favorites'} onClick={() => setQuick((current) => current === 'favorites' ? '' : 'favorites')}>Favorites</button>
                {GROUPS.map((item) => (
                  <button key={item.id} type="button" data-facet={item.id} className={`filter-choice${group === item.id || groupActive(item.id, query) ? ' on' : ''}`} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>
                ))}
                {group === 'bpm' ? BPM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    data-value={preset.id}
                    className={`filter-choice${query.bpmMin === preset.min && query.bpmMax === preset.max ? ' on' : ''}`}
                    aria-pressed={query.bpmMin === preset.min && query.bpmMax === preset.max}
                    onClick={() => setQuery((current) => ({ ...current, bpmMin: preset.min, bpmMax: preset.max }))}
                  >
                    {preset.label}
                  </button>
                )) : (
                  <>
                    <button type="button" data-value="any" className={`filter-choice${!selectedValue(group, query) ? ' on' : ''}`} aria-pressed={!selectedValue(group, query)} onClick={() => setQuery((current) => ({ ...current, ...cleared(group) }))}>Any</button>
                    {values.map((value) => (
                      <button key={value} type="button" data-value={value} className={`filter-choice${selectedValue(group, query) === value ? ' on' : ''}`} aria-pressed={selectedValue(group, query) === value} onClick={() => setQuery((current) => ({ ...current, ...picked(group, value) }))}>{chipLabel(value)}</button>
                    ))}
                  </>
                )}
                {group === 'bpm' && (
                  <>
                    <input className="library-filter-bpm" aria-label="Minimum BPM" inputMode="numeric" placeholder="Min" value={query.bpmMin ?? ''} onChange={(event) => setQuery((current) => ({ ...current, bpmMin: readBpm(event.target.value) }))} />
                    <input className="library-filter-bpm" aria-label="Maximum BPM" inputMode="numeric" placeholder="Max" value={query.bpmMax ?? ''} onChange={(event) => setQuery((current) => ({ ...current, bpmMax: readBpm(event.target.value) }))} />
                  </>
                )}
              </div>
            </AnchoredMenu>
          </div>
          {active.length > 0 && (
            <EqualSegments className="library-active btn-tray" label="Active filters">
              {active.map((item) => (
                <button key={item.id} type="button" className="on" aria-label={`Clear ${item.label}`} onClick={() => setQuery((current) => ({ ...current, ...item.clear }))}>{item.label} ×</button>
              ))}
            </EqualSegments>
          )}
          <div className="library-recent-head">
            <p className="sound-count library-count" data-library-count={rows.length}>{countLabel}</p>
            {quick === 'recent' && recent.length > 0 && <button type="button" className="library-clear-recent" onClick={() => clearRecent()}>Clear recent</button>}
          </div>
          <div className="sound-list" ref={listRef} aria-label="Library sounds">
            {rows.length === 0 && <p className="sound-status">Nothing matches.</p>}
            {rows.length > 0 && (
              <div style={{ height: rows.length * ROW, position: 'relative', width: '100%', maxWidth: '100%' }}>
                <div style={{ position: 'absolute', top: range.start * ROW, left: 0, right: 0, maxWidth: '100%' }}>
                  {shown.map((row) => {
                    const id = browseRowId(row)
                    return row.kind === 'instrument' ? (
                    <InstrumentRow
                      key={id}
                      item={row.instrument}
                      playing={playing === row.instrument.id}
                      busy={busy === row.instrument.id}
                      kept={focusId === id}
                      starred={isFavorite(id)}
                      onStar={() => toggleFavorite({ id, name: row.instrument.name, detail: row.instrument.category || 'Instrument', kind: 'instrument', instrument: row.instrument })}
                      onPlay={() => void previewInstrument(row.instrument)}
                      onLoad={() => { engine.unlock(); void loadInstrument(row.instrument) }}
                    />
                    ) : (
                    <SoundRow
                      key={id}
                      entry={row.entry}
                      playing={playing === row.entry.key}
                      busy={busy === row.entry.key}
                      kept={focusId === id}
                      starred={isFavorite(id)}
                      onStar={() => toggleFavorite({ id, name: row.entry.name, detail: row.entry.type || 'Sound', kind: 'library', library: row.entry, legacyId: row.entry.key })}
                      onPlay={() => void preview(row.entry.key)}
                      onLoad={() => { engine.unlock(); void load(row.entry.key) }}
                      onDrag={(event) => beginDrag(row.entry, event)}
                    />
                    )
                  })}
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
  kept,
  starred,
  onStar,
  onPlay,
  onLoad,
}: {
  item: LibraryInstrumentSummary
  playing: boolean
  busy: boolean
  kept: boolean
  starred: boolean
  onStar: () => void
  onPlay: () => void
  onLoad: () => void
}) {
  const span = item.notes <= 1 ? midiName(item.previewMidi) : `${midiName(item.lo)}–${midiName(item.hi)}`
  const meta = busy ? 'Loading' : playing ? 'Playing' : [item.category || 'Instrument', span].filter(Boolean).join(' · ')
  return (
    <div className={`sound-row${playing ? ' is-playing' : ''}${kept ? ' is-kept' : ''}`} data-library-instrument={item.id} data-browse-id={`instrument:${item.id}`}>
      <button type="button" className="sound-copy" aria-label={playing ? `Stop ${item.name}` : `Play ${item.name}`} onClick={onPlay}>
        <strong>{item.name}</strong>
        <span className="sound-meta">{busy ? 'Loading' : meta}</span>
      </button>
      <FavoriteStar name={item.name} pressed={starred} onToggle={onStar} />
      <button type="button" className="sound-add" aria-label={`Load ${item.name}`} disabled={busy} onClick={onLoad}>Load</button>
    </div>
  )
}

function SoundRow({
  entry,
  playing,
  busy,
  kept,
  starred,
  onStar,
  onPlay,
  onLoad,
  onDrag,
}: {
  entry: LibraryEntry
  playing: boolean
  busy: boolean
  kept: boolean
  starred: boolean
  onStar: () => void
  onPlay: () => void
  onLoad: () => void
  onDrag: (event: ReactDragEvent) => void
}) {
  const meta = busy ? 'Loading' : playing ? 'Playing' : [entry.type ? chipLabel(entry.type) : '', entry.category || entry.musicalKey || (entry.bpm ? `${entry.bpm} bpm` : '')].filter(Boolean).slice(0, 2).join(' · ')
  return (
    <div className={`sound-row${playing ? ' is-playing' : ''}${kept ? ' is-kept' : ''}`} data-library-key={entry.key} data-browse-id={`sound:${entry.key}`}>
      <button type="button" className="sound-copy" draggable aria-label={playing ? `Stop ${entry.name}` : `Play ${entry.name}`} onDragStart={onDrag} onClick={onPlay}>
        <strong>{entry.name}</strong>
        <span className="sound-meta">{busy ? 'Loading' : meta}</span>
      </button>
      <FavoriteStar name={entry.name} pressed={starred} onToggle={onStar} />
      <button type="button" className="sound-add" aria-label={`Load ${entry.name}`} disabled={busy} onClick={onLoad}>Load</button>
    </div>
  )
}

/** One row of equal cells. Cells share the row, and scroll at the widest label so nothing clips. */
function EqualSegments({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    let cancel = false
    const measure = () => {
      if (cancel) return
      const buttons = [...row.querySelectorAll<HTMLButtonElement>(':scope > button')]
      if (!buttons.length) return
      for (const button of buttons) {
        button.style.flex = '0 0 auto'
        button.style.width = 'max-content'
        button.style.minWidth = '40px'
      }
      const widest = Math.max(40, ...buttons.map((button) => Math.ceil(button.getBoundingClientRect().width))) + 1
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0
      const available = row.getBoundingClientRect().width
      const share = (available - gap * Math.max(0, buttons.length - 1)) / buttons.length
      const locked = widest > share + 0.5
      for (const button of buttons) {
        if (locked) {
          button.style.flex = `0 0 ${widest}px`
          button.style.width = `${widest}px`
          button.style.minWidth = `${widest}px`
        } else {
          button.style.flex = '1 1 0px'
          button.style.width = '0px'
          button.style.minWidth = '0px'
        }
      }
    }
    measure()
    const frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    void document.fonts?.ready.then(measure)
    return () => {
      cancel = true
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  })
  return (
    <div ref={ref} className={['library-filter-options', className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {children}
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
