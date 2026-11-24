import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type FormEvent, type RefObject } from 'react'
import { SOUND_MIME } from '../audio/sample/slot'
import { LibraryAuthError, clearLibraryAccessKey, libraryStatus, readLibraryAccessKey, writeLibraryAccessKey } from '../library/access'
import { loadLibraryCatalog } from '../library/audio'
import { browseLibraryRows, type BrowseRow } from '../library/browse'
import { contentTypeChoices, contentTypeLabel, isLoopEntry } from '../library/contentType'
import {
  buildFastRows,
  classifyDrum,
  fastOffsetForId,
  fastSounds,
  fastVisibleRange,
  isNearSongTempo,
  mergeBrowseHits,
  nearSongWindow,
  type DrumSub,
  type FastMode,
  type FastSort,
} from '../library/fastBrowse'
import { browseIndexForId, browseRowId, laneForType, readBrowsePlace, scrollTopForIndex, typeForLane, writeBrowsePlace, type LibraryLane } from './browsePlace'
import { clearRecent, recentSounds, subscribeRecent } from '../library/recent'
import { absorbLegacyFavoriteIds, favoriteSounds, isFavorite, subscribeFavorites, toggleFavorite } from '../library/favorites'
import { FavoriteStar } from './FavoriteStar'
import { groupLibraryInstruments, midiName, summarizeInstrument, type LibraryInstrument, type LibraryInstrumentSummary } from '../library/group'
import { fetchAllLibraryInstruments } from '../library/instrumentsApi'
import { addLibraryToTrack, libraryDragId, loadGroupedLibraryInstrument, loadLibraryDrag, loadLibraryEntry, placeLibraryInstrument, previewLibraryInstrument, publishLibrary, useLibraryOnPad } from '../library/place'
import { prefetchLibrarySounds, previewLibraryLoopAtTempo, previewLibrarySound } from '../library/stream'
import { retargetLibraryMemory } from '../library/retarget'
import { KEY_TONICS, libraryDetectKeys, parseMusicalKey, projectKeyFromScale, resolveEntryKey, type MusicalKey } from '../library/musicalKey'
import { libraryRowWindow, searchLibrary, type LibraryIndex } from '../library/search'
import { EMPTY_LIBRARY_QUERY, type LibraryDocument, type LibraryEntry, type LibraryQuery } from '../library/types'
import { LIBRARY_UPLOAD_MAX_BYTES, readWavFacts, uploadLibraryWavs } from '../library/upload'
import type { ProjectStore } from '../state/store'
import { useProjectVersion } from './playbackUi'

/** The row is 64px tall plus the 6px margin under it. Virtualization uses that stride. */
const ROW = 64 + 6
const GROUPS = [
  { id: 'type', label: 'Type' },
  { id: 'instrument', label: 'Instrument' },
  { id: 'key', label: 'Key' },
  { id: 'bpm', label: 'BPM' },
  { id: 'genre', label: 'Genre' },
  { id: 'mood', label: 'Mood' },
  { id: 'pack', label: 'Pack' },
] as const

type Group = 'type' | 'category' | 'instrument' | 'genre' | 'key' | 'bpm' | 'mood' | 'pack'

const BPM_PRESETS: { id: string; label: string; min: number | null; max: number | null }[] = [
  { id: 'any', label: 'Any BPM', min: null, max: null },
  { id: 'slow', label: '60–90', min: 60, max: 90 },
  { id: 'mid', label: '90–120', min: 90, max: 120 },
  { id: 'up', label: '120–150', min: 120, max: 150 },
  { id: 'fast', label: '150+', min: 150, max: null },
]

const TYPE_LABEL: Record<string, string> = {
  instrument: 'Instrument',
  'one-shot': 'One-shot',
  loop: 'Loop',
  sfx: 'SFX',
  'drum-kit': 'Drum kit',
  upload: 'Upload',
}

type Engine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number, loop?: boolean) => void
  feedPreview?: (token: number, channels: Float32Array[], sampleRate: number, gain?: number) => boolean | void
  setPreviewGain?: (token: number, gain: number) => void
  continuePreviewLoop?: (token: number, channels: Float32Array[], sampleRate: number, gain?: number) => boolean | void
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

export function MyLibrary({
  store,
  engine,
  variant = 'library',
  pad = null,
}: {
  store: ProjectStore
  engine: Engine
  /** Pad browser browses drum one-shots and loads them onto the selected pad. */
  variant?: 'library' | 'pads'
  pad?: { trackId: string; bank: number; index: number } | null
}) {
  const saved = useRef(readBrowsePlace())
  const savedLane: LibraryLane = variant === 'pads' ? '' : saved.current.libraryLane
  const [phase, setPhase] = useState<'check' | 'off' | 'lock' | 'load' | 'ready'>('check')
  const [message, setMessage] = useState('Checking the library…')
  const [passphrase, setPassphrase] = useState('')
  const [index, setIndex] = useState<LibraryIndex | null>(null)
  const [instruments, setInstruments] = useState<LibraryInstrumentSummary[]>([])
  const grouped = useRef<LibraryInstrument[]>([])
  const coveredKeys = useRef<Set<string>>(new Set())
  const [text, setText] = useState(variant === 'pads' ? saved.current.padText : saved.current.libraryText)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [group, setGroup] = useState<Group>(saved.current.libraryGroup as Group)
  const [query, setQuery] = useState<LibraryQuery>(
    variant === 'pads'
      ? { ...EMPTY_LIBRARY_QUERY }
      : savedLane === 'favorites'
        ? { ...saved.current.libraryQuery, type: '' }
        : savedLane === 'drums'
          ? { ...saved.current.libraryQuery, type: 'one-shot' }
          : saved.current.libraryQuery,
  )
  const [busy, setBusy] = useState('')
  const [playing, setPlaying] = useState('')
  const [focusId, setFocusId] = useState(saved.current.libraryFocus)
  const [quick, setQuick] = useState<'' | 'recent' | 'favorites'>(
    variant === 'pads' ? '' : savedLane === 'favorites' ? 'favorites' : saved.current.libraryQuick === 'favorites' ? '' : saved.current.libraryQuick,
  )
  const [lane, setLane] = useState<LibraryLane>(savedLane)
  const [listScrolled, setListScrolled] = useState(false)
  const [drumCategory, setDrumCategory] = useState(variant === 'pads' ? saved.current.padCategory : saved.current.drumCategory)
  const [drumSub, setDrumSub] = useState<DrumSub | ''>(variant === 'pads' ? saved.current.padSub : saved.current.drumSub)
  const [loopCategory, setLoopCategory] = useState(saved.current.loopCategory)
  const [loopGenre, setLoopGenre] = useState(saved.current.loopGenre)
  const [loopSort, setLoopSort] = useState<FastSort>(saved.current.loopSort)
  const [collapsed, setCollapsed] = useState<string[]>(saved.current.collapsedSections)
  const [stuckId, setStuckId] = useState('')
  const [range, setRange] = useState({ start: 0, end: 16 })
  const version = useProjectVersion(store)
  const projectKey = useMemo(() => projectKeyFromScale(store.project.scale), [store, version])
  const heard = useMemo(() => libraryDetectKeys(store.project), [store, version])
  const recent = useSyncExternalStore(subscribeRecent, recentSounds, recentSounds)
  const favorites = useSyncExternalStore(subscribeFavorites, favoriteSounds, favoriteSounds)
  const listRef = useRef<HTMLDivElement>(null)
  const addFiles = useRef<HTMLInputElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addCategory, setAddCategory] = useState('')
  const [addBpm, setAddBpm] = useState('')
  const [addKey, setAddKey] = useState('')
  const [addMessage, setAddMessage] = useState('')
  const [adding, setAdding] = useState(false)
  const swipe = useRef({ x: 0, y: 0, moved: false })
  const previewGen = useRef(0)
  const previewAbort = useRef<AbortController | null>(null)

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
    previewAbort.current?.abort()
    previewGen.current += 1
    engine.stopPreview()
  }, [engine])

  useEffect(() => {
    if (!filtersOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setFiltersOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filtersOpen])

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

  const searchQuery = useMemo(() => {
    const musicalKey = query.musicalKey === 'project' ? projectKey.label : query.musicalKey
    const type = variant === 'pads' ? 'one-shot' : query.type
    return { ...query, text, musicalKey, type }
  }, [projectKey, query, text, variant])

  const rows = useMemo<BrowseRow[]>(() => {
    if (!index) return []
    const next = searchQuery
    const listed = browseLibraryRows(index, searchLibrary(index, next, heard), instruments, next, coveredKeys.current)
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
  }, [favorites, heard, index, instruments, quick, recent, searchQuery])

  const fastMode: FastMode | '' = variant === 'pads'
    ? 'drum'
    : quick
      ? ''
      : lane === 'drums' || lane === 'oneshots' || query.type === 'one-shot'
        ? 'drum'
        : lane === 'loops' || query.type === 'loop'
          ? 'loop'
          : ''
  const fastCategory = fastMode === 'drum' ? drumCategory : loopCategory
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed])
  const favoriteKeys = useMemo(() => memoryKeys(favorites), [favorites])
  const recentKeys = useMemo(() => memoryKeys(recent), [recent])
  const fastModel = useMemo(() => {
    if (!fastMode || !index) return null
    const sounds = rows.flatMap((row) => row.kind === 'sound' ? [row.entry] : [])
    let pool = sounds
    if (text.trim() && !quick) {
      const open = { ...searchQuery, text: '' }
      const extra = browseLibraryRows(index, searchLibrary(index, open, heard), instruments, open, coveredKeys.current)
        .flatMap((row) => row.kind === 'sound' ? [row.entry] : [])
      pool = mergeBrowseHits(sounds, extra, text, fastMode)
    }
    if (lane === 'drums') pool = pool.filter((entry) => {
      const drum = classifyDrum(entry)
      return !!drum && drum.id !== 'bass'
    })
    return buildFastRows({
      entries: pool,
      mode: fastMode,
      category: fastCategory,
      sub: fastMode === 'drum' ? drumSub : '',
      genre: fastMode === 'loop' ? loopGenre : '',
      sort: loopSort,
      collapsed: collapsedSet,
      favoriteKeys,
      recentKeys,
      keyLabel: (entry) => resolveEntryKey(entry, heard.get(entry.key) ?? null)?.label ?? entry.musicalKey,
    })
  }, [collapsedSet, drumSub, fastCategory, fastMode, favoriteKeys, heard, index, instruments, lane, loopGenre, loopSort, quick, recentKeys, rows, searchQuery, text])
  const filterKey = `${text}\0${JSON.stringify(query)}\0${projectKey.label}\0${fastCategory}\0${drumSub}\0${loopGenre}\0${loopSort}\0${lane}`
  const filterKeyRef = useRef(filterKey)
  const didRestore = useRef(false)
  useEffect(() => {
    if (variant === 'pads') {
      writeBrowsePlace({ padText: text, padCategory: drumCategory, padSub: drumSub, collapsedSections: collapsed })
      return
    }
    writeBrowsePlace({
      libraryText: text,
      libraryQuery: query,
      libraryGroup: group,
      libraryQuick: quick,
      libraryLane: lane,
      drumCategory,
      drumSub,
      loopCategory,
      loopGenre,
      loopSort,
      collapsedSections: collapsed,
    })
  }, [collapsed, drumCategory, drumSub, group, lane, loopCategory, loopGenre, loopSort, query, quick, text, variant])
  useEffect(() => {
    absorbLegacyFavoriteIds(store.project.soundFavorites ?? [])
  }, [store])

  useEffect(() => {
    if (variant === 'pads' || phase !== 'ready' || !lane) return
    const node = document.querySelector(`.library-lanes [data-lane="${lane}"]`)
    if (node instanceof HTMLElement) node.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [lane, phase, variant])

  const prefetchKey = phase === 'ready'
    ? rows.filter((row) => row.kind === 'sound').slice(0, 2).map((row) => row.entry.key).join('\n')
    : ''
  useEffect(() => {
    if (!prefetchKey) return
    const controller = new AbortController()
    const entries = prefetchKey.split('\n').map((key) => index?.entries.find((entry) => entry.key === key)).filter((entry): entry is LibraryEntry => Boolean(entry))
    void prefetchLibrarySounds(entries, undefined, controller.signal)
    return () => controller.abort()
  }, [prefetchKey, index])

  function keep(id: string) {
    setFocusId(id)
    if (variant === 'pads') writeBrowsePlace({ padAnchor: id })
    else writeBrowsePlace({ libraryFocus: id, libraryAnchor: id })
  }

  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const scroller = scrollParent(node)
    const update = () => {
      const library = node.closest('.my-library') as HTMLElement | null
      const sticky = library?.querySelector('.library-sticky')
      if (library && sticky) library.style.setProperty('--library-sticky-h', `${Math.ceil(sticky.getBoundingClientRect().height)}px`)
      const listIsScroller = scroller === node
      const scrolled = listIsScroller
        ? scroller.scrollTop
        : Math.max(0, scroller.getBoundingClientRect().top - node.getBoundingClientRect().top)
      const nextScrolled = scrolled > 12
      setListScrolled((prev) => prev === nextScrolled ? prev : nextScrolled)
      const viewHeight = Math.min(scroller.clientHeight || window.innerHeight, window.innerHeight || scroller.clientHeight)
      if (fastModel) {
        const next = fastVisibleRange(fastModel.offsets, fastModel.rows.map((row) => row.height), scrolled, viewHeight)
        setRange((prev) => prev.start === next.start && prev.end === next.end ? prev : next)
        let at = 0
        for (let i = 0; i < fastModel.rows.length; i++) {
          if (fastModel.offsets[i] <= scrolled) at = i
        }
        const row = fastModel.rows[at]
        const nextStuck = row?.kind === 'head'
          ? row.id
          : row?.entry
            ? ([...fastModel.rows.slice(0, at + 1)].reverse().find((item) => item.kind === 'head' && !item.id.includes(':letter:'))?.id ?? '')
            : ''
        if (row?.kind === 'head' || row?.entry) setStuckId((prev) => prev === nextStuck ? prev : nextStuck)
        if (row?.entry) {
          const id = `sound:${row.entry.key}`
          if (variant === 'pads') writeBrowsePlace({ padAnchor: id })
          else writeBrowsePlace({ libraryAnchor: id })
        }
        return
      }
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
    } else if (!didRestore.current && (fastModel ? fastModel.rows.length : rows.length)) {
      const place = readBrowsePlace()
      const savedId = variant === 'pads' ? place.padAnchor : (place.libraryFocus || place.libraryAnchor)
      if (fastModel) {
        const top = fastOffsetForId(fastModel.rows, fastModel.offsets, savedId)
        if (top >= 0) {
          scroller.scrollTop = top
          if (scroller !== node) node.scrollTop = top
          didRestore.current = true
        }
      } else {
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
  }, [fastModel, rows, phase, filterKey, variant])

  async function unlock(event: React.FormEvent) {
    event.preventDefault()
    const next = passphrase.trim()
    if (!next) return
    writeLibraryAccessKey(next)
    setPassphrase('')
    await openCatalog()
  }

  async function submitAdds(event: FormEvent) {
    event.preventDefault()
    const picked = [...(addFiles.current?.files ?? [])]
    if (!picked.length) {
      setAddMessage('Choose WAV files.')
      return
    }
    const accessKey = readLibraryAccessKey()
    if (!accessKey) {
      setPhase('lock')
      setMessage('Enter the library passphrase. It stays on this phone.')
      return
    }
    const tempo = addBpm.trim()
    const bpm = tempo ? Number(tempo) : null
    if (tempo && !(bpm && Number.isFinite(bpm) && bpm > 0 && bpm <= 400)) {
      setAddMessage('BPM should be a tempo, or left blank.')
      return
    }
    setAdding(true)
    setAddMessage('Uploading…')
    try {
      const files: { name: string; size: number; bytes: ArrayBuffer }[] = []
      let rejected = 0
      for (const file of picked) {
        if (!file.name.toLowerCase().endsWith('.wav') || file.size < 1 || file.size > LIBRARY_UPLOAD_MAX_BYTES) {
          rejected += 1
          continue
        }
        const bytes = await file.arrayBuffer()
        if (!readWavFacts(bytes)) {
          rejected += 1
          continue
        }
        files.push({ name: file.name, size: bytes.byteLength, bytes })
      }
      const result = files.length
        ? await uploadLibraryWavs({ files, category: addCategory, bpm, musicalKey: addKey, accessKey })
        : { uploaded: 0, skipped: 0, added: 0, failed: 0 }
      const failed = rejected + result.failed
      setAddMessage(`Added ${result.added}. Skipped ${result.skipped}. Failed ${failed}.`)
      if (addFiles.current) addFiles.current.value = ''
      if (result.added > 0) await openCatalog()
    } catch (error) {
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      const text = error instanceof Error ? error.message : 'Could not add those sounds.'
      setAddMessage(accessKey && text.includes(accessKey) ? 'Could not add those sounds.' : text)
    } finally {
      setAdding(false)
    }
  }

  function lock() {
    previewAbort.current?.abort()
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
      previewAbort.current?.abort()
      previewGen.current += 1
      engine.stopPreview()
      setPlaying('')
      return
    }
    previewAbort.current?.abort()
    const controller = new AbortController()
    previewAbort.current = controller
    const gen = ++previewGen.current
    engine.stopPreview()
    setPlaying('')
    setBusy(key)
    try {
      engine.unlock()
      const onStart = () => {
        if (gen !== previewGen.current || controller.signal.aborted) return
        setPlaying(key)
        setBusy('')
      }
      if (fastMode === 'loop' && isLoopEntry(entry)) {
        await previewLibraryLoopAtTempo({
          entry,
          toRate: store.project.sampleRate,
          songBpm: store.project.tempo,
          signal: controller.signal,
          engine,
          decode: decodeOf(engine),
          onStart,
        })
      } else {
        await previewLibrarySound({
          entry,
          toRate: store.project.sampleRate,
          token: gen,
          signal: controller.signal,
          engine,
          decode: decodeOf(engine),
          onStart,
        })
      }
    } catch (error) {
      if (gen !== previewGen.current || controller.signal.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
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

  function scrollToBrowseId(id: string) {
    const node = listRef.current
    if (!node || !fastModel) return
    const top = fastOffsetForId(fastModel.rows, fastModel.offsets, id)
    if (top < 0) return
    const scroller = scrollParent(node)
    scroller.scrollTop = top
    if (scroller !== node) node.scrollTop = top
  }

  function toggleSection(id: string) {
    setCollapsed((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  function jumpTo(id: string) {
    if (collapsed.includes(id)) setCollapsed((current) => current.filter((item) => item !== id))
    scrollToBrowseId(id)
  }

  function stepSound(dir: number) {
    const list = fastModel ? fastSounds(fastModel.rows) : []
    if (!list.length) return
    const current = playing || focusId.replace(/^sound:/, '')
    let index = list.findIndex((entry) => entry.key === current)
    if (index < 0) index = dir > 0 ? -1 : 0
    const next = list[(index + dir + list.length) % list.length]
    scrollToBrowseId(`sound:${next.key}`)
    void preview(next.key)
  }

  async function useOnPad(entry: LibraryEntry) {
    keep(`sound:${entry.key}`)
    setBusy(entry.key)
    try {
      engine.unlock()
      const note = await useLibraryOnPad(store, entry, variant === 'pads' ? pad : null, decodeOf(engine))
      store.toast(note, 'good')
    } catch (error) {
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      store.toast(error instanceof Error ? error.message : 'Could not put that sound on a pad.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function addToTrack(entry: LibraryEntry) {
    keep(`sound:${entry.key}`)
    setBusy(entry.key)
    try {
      engine.unlock()
      const note = await addLibraryToTrack(store, entry, engine.currentTimelineSample(), decodeOf(engine))
      store.toast(note, 'good')
    } catch (error) {
      if (error instanceof LibraryAuthError) {
        setPhase('lock')
        setMessage(error.message)
        return
      }
      store.toast(error instanceof Error ? error.message : 'Could not add that sound onto the track.', 'warn')
    } finally {
      setBusy('')
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
    previewAbort.current?.abort()
    previewAbort.current = null
    if (playing === item.id) {
      previewGen.current += 1
      engine.stopPreview()
      setPlaying('')
      return
    }
    const gen = ++previewGen.current
    engine.stopPreview()
    setPlaying('')
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

  function applyFilter(patch: Partial<LibraryQuery>) {
    setQuery((current) => ({ ...current, ...patch }))
    if ('type' in patch) setLane(laneForType(patch.type ?? ''))
    if (patch.type) setQuick('')
    setFiltersOpen(false)
  }

  function pickLane(next: LibraryLane) {
    if (lane === next) {
      setLane('')
      setQuick('')
      setQuery((current) => ({ ...current, type: '' }))
      return
    }
    setLane(next)
    if (next === 'favorites') {
      setQuick('favorites')
      setQuery((current) => ({ ...current, type: '' }))
      return
    }
    setQuick('')
    if (next === 'drums' && drumCategory === 'other') setDrumCategory('')
    setQuery((current) => ({ ...current, type: typeForLane(next) }))
  }

  function pickQuick(id: 'recent' | 'favorites') {
    const turningOff = quick === id
    setQuick(turningOff ? '' : id)
    if (id === 'favorites') {
      if (turningOff) setLane(laneForType(query.type))
      else {
        setLane('favorites')
        setQuery((current) => ({ ...current, type: '' }))
      }
    }
    setFiltersOpen(false)
  }

  function toggleCompatible() {
    const hasKey = Boolean(query.musicalKey)
    setQuery((current) => ({ ...current, keyCompatible: !current.keyCompatible }))
    if (hasKey) setFiltersOpen(false)
  }

  function clearAllFilters() {
    setQuery({ ...EMPTY_LIBRARY_QUERY })
    setQuick('')
    setLane('')
  }

  const facets = index?.facets
  const panel: Group = group === 'category' ? 'instrument' : group
  const values = panel === 'key' || panel === 'bpm' || panel === 'instrument' || panel === 'type' ? [] : facetValues(panel, facets, instruments.length > 0)
  const typeChoices = useMemo(() => contentTypeChoices(
    (index?.entries ?? []).filter((entry) => entry.type !== 'multisample note' && !coveredKeys.current.has(entry.key)),
    instruments,
  ), [index, instruments])
  const categoryValues = facetValues('category', facets, false)
  const instrumentValues = facetValues('instrument', facets, false)
  const active = activeFilters(query, projectKey)
    .filter((item) => !(item.id === 'type' && lane))
    .map((item) => item.id === 'type' && lane === 'drums' ? { ...item, label: 'Drums' } : item)
  const activeCount = active.length + (quick ? 1 : 0)
  const shown = fastModel ? [] : rows.slice(range.start, range.end)
  const fastShown = fastModel ? fastModel.rows.slice(range.start, range.end) : []
  const instrumentCount = fastModel ? rows.filter((row) => row.kind === 'instrument').length : rows.filter((row) => row.kind === 'instrument').length
  const soundCount = fastModel ? fastModel.sounds : rows.length - instrumentCount
  const counted = fastModel ? fastModel.sounds + instrumentCount : rows.length
  const countLabel = counted === 0
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
          <div className="library-sticky">
          <div className="sound-filters library-search">
            <input aria-label="Search my library" placeholder="Search" value={text} onChange={(event) => setText(event.target.value)} />
            <button
              type="button"
              className={`sound-filter library-filter-btn${activeCount ? ' on' : ''}`}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              aria-label={activeCount ? `Filter. ${activeCount} active. ${[quick === 'recent' ? 'Recent' : quick === 'favorites' ? 'Favorites' : '', ...active.map((item) => item.label)].filter(Boolean).join(', ')}.` : 'Filter'}
              title="Loops, type, instrument, key, tempo, and genre."
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <FilterIcon />
              {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
            </button>
            <button type="button" className="sound-filter library-lock-btn" onClick={lock}>Lock</button>
          </div>
          {variant === 'library' && (
            <LibraryAddSounds
              open={addOpen}
              category={addCategory}
              bpm={addBpm}
              musicalKey={addKey}
              message={addMessage}
              busy={adding}
              fileRef={addFiles}
              onToggle={() => setAddOpen((open) => !open)}
              onCategory={setAddCategory}
              onBpm={setAddBpm}
              onKey={setAddKey}
              onSubmit={(event) => void submitAdds(event)}
            />
          )}
          {variant === 'library' && <LibraryLanes lane={lane} onPick={pickLane} />}
          {filtersOpen && <div className="sound-filter-menu library-filter-sheet" role="dialog" aria-label="Filter">
              <div className="library-filter-chips" role="group" aria-label="Filter groups">
                {GROUPS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-facet={item.id}
                    aria-pressed={panel === item.id}
                    title={item.id === 'instrument' ? 'Instrument and category' : item.label}
                    className={`filter-choice${panel === item.id || chipOn(item.id, query) ? ' on' : ''}`}
                    onClick={() => setGroup(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
                <button type="button" className={`filter-choice library-quick${quick === 'recent' ? ' on' : ''}`} data-quick="recent" aria-pressed={quick === 'recent'} onClick={() => pickQuick('recent')}>Recent</button>
                <button type="button" className={`filter-choice library-quick${quick === 'favorites' ? ' on' : ''}`} data-quick="favorites" aria-pressed={quick === 'favorites'} onClick={() => pickQuick('favorites')}>Favorites</button>
              </div>
              {panel === 'key' ? (
                <KeyPicker query={query} project={projectKey} onPick={(value) => applyFilter(value ? { musicalKey: value } : { musicalKey: '', keyCompatible: false })} onCompatible={toggleCompatible} />
              ) : panel === 'bpm' ? (
                <div className="library-filter-list" role="group" aria-label="BPM">
                  {BPM_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      data-value={preset.id}
                      className={`filter-choice${query.bpmMin === preset.min && query.bpmMax === preset.max ? ' on' : ''}`}
                      aria-pressed={query.bpmMin === preset.min && query.bpmMax === preset.max}
                      onClick={() => applyFilter({ bpmMin: preset.min, bpmMax: preset.max })}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <div className="library-bpm-range">
                    <input className="library-filter-bpm" aria-label="Minimum BPM" inputMode="numeric" placeholder="Min" value={query.bpmMin ?? ''} onChange={(event) => setQuery((current) => ({ ...current, bpmMin: readBpm(event.target.value) }))} />
                    <input className="library-filter-bpm" aria-label="Maximum BPM" inputMode="numeric" placeholder="Max" value={query.bpmMax ?? ''} onChange={(event) => setQuery((current) => ({ ...current, bpmMax: readBpm(event.target.value) }))} />
                  </div>
                </div>
              ) : panel === 'instrument' ? (
                <div className="library-filter-list" role="group" aria-label="Instrument and category">
                  <p className="filter-label">Category</p>
                  <button type="button" data-value="any-category" className={`filter-choice${!query.category ? ' on' : ''}`} onClick={() => applyFilter({ category: '' })}>Any category</button>
                  {categoryValues.map((value) => (
                    <button key={`cat-${value}`} type="button" data-value={value} className={`filter-choice${query.category === value ? ' on' : ''}`} aria-pressed={query.category === value} onClick={() => applyFilter({ category: value })}>{chipLabel(value)}</button>
                  ))}
                  <p className="filter-label">Instrument</p>
                  <button type="button" data-value="any-instrument" className={`filter-choice${!query.instrument ? ' on' : ''}`} onClick={() => applyFilter({ instrument: '' })}>Any instrument</button>
                  {instrumentValues.map((value) => (
                    <button key={`inst-${value}`} type="button" data-value={value} className={`filter-choice${query.instrument === value ? ' on' : ''}`} aria-pressed={query.instrument === value} onClick={() => applyFilter({ instrument: value })}>{chipLabel(value)}</button>
                  ))}
                </div>
              ) : panel === 'type' ? (
                <div className="library-filter-list" role="group" aria-label="Type. Loops, one-shots, instruments, and the other kinds in this library.">
                  <button type="button" data-value="any" className={`filter-choice${!query.type ? ' on' : ''}`} aria-pressed={!query.type} onClick={() => applyFilter({ type: '' })}>Any</button>
                  {typeChoices.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      data-value={choice.id}
                      data-content-type={choice.id}
                      className={`filter-choice${query.type === choice.id ? ' on' : ''}`}
                      aria-pressed={query.type === choice.id}
                      aria-label={choice.label}
                      onClick={() => applyFilter({ type: choice.id })}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="library-filter-list" role="group" aria-label={chipLabel(panel)}>
                  <button type="button" data-value="any" className={`filter-choice${!selectedValue(panel, query) ? ' on' : ''}`} aria-pressed={!selectedValue(panel, query)} onClick={() => applyFilter(cleared(panel))}>Any</button>
                  {values.map((value) => (
                    <button key={value} type="button" data-value={value} className={`filter-choice${selectedValue(panel, query) === value ? ' on' : ''}`} aria-pressed={selectedValue(panel, query) === value} onClick={() => applyFilter(picked(panel, value))}>{chipLabel(value)}</button>
                  ))}
                </div>
              )}
          </div>}
          {(active.length > 0 || quick) && (
            <div className="library-active-bar" role="group" aria-label="Active filters">
              {quick && (
                <button type="button" className="library-active-chip" aria-label={`Clear ${quick === 'recent' ? 'Recent' : 'Favorites'}`} onClick={() => {
                  setQuick('')
                  if (quick === 'favorites') setLane('')
                }}>
                  <span>{quick === 'recent' ? 'Recent' : 'Favorites'}</span>
                  <span aria-hidden="true">×</span>
                </button>
              )}
              {active.map((item) => (
                <button key={item.id} type="button" className="library-active-chip" aria-label={`Clear ${item.label}`} onClick={() => {
                  setQuery((current) => ({ ...current, ...item.clear }))
                  if (item.id === 'type') setLane('')
                }}>
                  <span>{item.label}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
              <button type="button" className="library-clear-all" onClick={clearAllFilters}>Clear all</button>
            </div>
          )}
          {fastModel && (
            <FastShelf
              mode={fastMode === 'loop' ? 'loop' : 'drum'}
              model={fastModel}
              category={fastCategory}
              sub={drumSub}
              genre={loopGenre}
              sort={loopSort}
              nearTempo={isNearSongTempo(query.bpmMin, query.bpmMax, store.project.tempo)}
              inKey={query.musicalKey === 'project' && !query.keyCompatible}
              compatible={query.musicalKey === 'project' && query.keyCompatible === true}
              songKey={projectKey.short}
              stuck={listScrolled ? (fastModel.rows.find((row) => row.id === stuckId)?.label ?? '') : ''}
              onCategory={(id) => {
                if (fastMode === 'loop') setLoopCategory(id)
                else {
                  setDrumCategory(id)
                  setDrumSub('')
                }
              }}
              onSub={(id) => setDrumSub(id)}
              onGenre={(id) => setLoopGenre((current) => current === id ? '' : id)}
              onSort={setLoopSort}
              onNearTempo={() => {
                if (isNearSongTempo(query.bpmMin, query.bpmMax, store.project.tempo)) setQuery((current) => ({ ...current, bpmMin: null, bpmMax: null }))
                else {
                  const band = nearSongWindow(store.project.tempo)
                  setQuery((current) => ({ ...current, bpmMin: band.bpmMin, bpmMax: band.bpmMax }))
                }
              }}
              onTempo={(center) => {
                const band = nearSongWindow(center)
                setQuery((current) => ({ ...current, bpmMin: band.bpmMin, bpmMax: band.bpmMax }))
              }}
              tempoCenter={query.bpmMin != null && query.bpmMax != null ? Math.round((query.bpmMin + query.bpmMax) / 2) : Math.round(store.project.tempo)}
              onInKey={() => setQuery((current) => current.musicalKey === 'project' && !current.keyCompatible ? { ...current, musicalKey: '', keyCompatible: false } : { ...current, musicalKey: 'project', keyCompatible: false })}
              onCompatible={() => setQuery((current) => current.musicalKey === 'project' && current.keyCompatible ? { ...current, musicalKey: '', keyCompatible: false } : { ...current, musicalKey: 'project', keyCompatible: true })}
              onJump={jumpTo}
              onStep={stepSound}
              onToggleStuck={() => { if (stuckId) toggleSection(stuckId) }}
            />
          )}
          </div>
          <div className="library-recent-head">
            <p className="sound-count library-count" data-library-count={counted}>{countLabel}</p>
            {quick === 'recent' && recent.length > 0 && <button type="button" className="library-clear-recent" onClick={() => clearRecent()}>Clear recent</button>}
          </div>
          <div
            className="sound-list"
            ref={listRef}
            aria-label="Library sounds"
            data-fast-browse={fastMode || undefined}
            onPointerDown={(event) => {
              if (!fastModel) return
              swipe.current = { x: event.clientX, y: event.clientY, moved: false }
            }}
            onPointerUp={(event) => {
              if (!fastModel) return
              const dx = event.clientX - swipe.current.x
              const dy = event.clientY - swipe.current.y
              if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return
              swipe.current.moved = true
              stepSound(dx < 0 ? 1 : -1)
            }}
            onClickCapture={(event) => {
              if (!swipe.current.moved) return
              swipe.current.moved = false
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            {counted === 0 && <p className="sound-status">Nothing matches.</p>}
            {fastModel && fastModel.rows.length > 0 && (
              <div className="fast-list" style={{ height: fastModel.total, position: 'relative', width: '100%', maxWidth: '100%' }}>
                <div style={{ position: 'absolute', top: fastModel.offsets[range.start] ?? 0, left: 0, right: 28, maxWidth: '100%' }}>
                  {fastShown.map((row) => row.kind === 'head' ? (
                    <button
                      key={row.id}
                      type="button"
                      className={`fast-section${row.id.includes(':letter:') ? ' fast-letter' : ''}`}
                      data-section={row.id}
                      aria-expanded={!collapsed.includes(row.id)}
                      onClick={() => toggleSection(row.id)}
                    >
                      <strong>{row.label}</strong>
                      <span>{row.count}</span>
                    </button>
                  ) : row.entry ? (
                    <SoundRow
                      key={row.id}
                      entry={row.entry}
                      musical={resolveEntryKey(row.entry, heard.get(row.entry.key) ?? null)}
                      playing={playing === row.entry.key}
                      busy={busy === row.entry.key}
                      kept={focusId === row.id}
                      starred={isFavorite(row.id) || isFavorite(`library:${row.entry.key}`)}
                      shelf={fastMode === 'loop' ? 'loop' : 'drum'}
                      onStar={() => toggleFavorite({ id: row.id, name: row.entry!.name, detail: row.entry!.type || 'Sound', kind: 'library', library: row.entry!, legacyId: row.entry!.key })}
                      onPlay={() => void preview(row.entry!.key)}
                      onLoad={() => { engine.unlock(); void load(row.entry!.key) }}
                      onPad={() => { engine.unlock(); void useOnPad(row.entry!) }}
                      onTrack={() => { engine.unlock(); void addToTrack(row.entry!) }}
                      onDrag={(event) => beginDrag(row.entry!, event)}
                    />
                  ) : null)}
                </div>
                <div className="fast-jump" role="navigation" aria-label="Jump to">
                  {fastModel.jump.map((item) => (
                    <button key={item.id} type="button" data-jump={item.id} aria-label={`Jump to ${item.label}`} title={item.label} onClick={() => jumpTo(item.id)}>{item.short}</button>
                  ))}
                </div>
              </div>
            )}
            {!fastModel && rows.length > 0 && (
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
                      musical={resolveEntryKey(row.entry, heard.get(row.entry.key) ?? null)}
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
  musical,
  playing,
  busy,
  kept,
  starred,
  shelf = '',
  onStar,
  onPlay,
  onLoad,
  onPad,
  onTrack,
  onDrag,
}: {
  entry: LibraryEntry
  musical: MusicalKey | null
  playing: boolean
  busy: boolean
  kept: boolean
  starred: boolean
  shelf?: '' | 'drum' | 'loop'
  onStar: () => void
  onPlay: () => void
  onLoad: () => void
  onPad?: () => void
  onTrack?: () => void
  onDrag: (event: ReactDragEvent) => void
}) {
  const bpmLabel = entry.bpm != null && entry.bpm > 0 ? `${Math.round(entry.bpm)} bpm` : ''
  const meta = busy
    ? 'Loading'
    : playing
      ? 'Playing'
      : isLoopEntry(entry)
        ? ['Loop', bpmLabel, musical?.short ?? '', entry.category ? chipLabel(entry.category) : ''].filter(Boolean).join(' · ')
        : [entry.type ? chipLabel(entry.type) : '', entry.category || bpmLabel].filter(Boolean).slice(0, 2).join(' · ')
  const keyTitle = musical?.source === 'filename' ? `${musical.label}, read from the name` : musical?.source === 'detect' ? `${musical.label}, from Detect` : musical?.label
  return (
    <div className={`sound-row${playing ? ' is-playing' : ''}${kept ? ' is-kept' : ''}`} data-library-key={entry.key} data-browse-id={`sound:${entry.key}`} data-sound-bpm={bpmLabel ? String(Math.round(entry.bpm ?? 0)) : undefined} data-content-type={isLoopEntry(entry) ? 'loop' : entry.type || undefined}>
      <button type="button" className="sound-copy" draggable aria-label={playing ? `Stop ${entry.name}` : `Play ${entry.name}`} onDragStart={onDrag} onClick={onPlay}>
        <span className="sound-title">
          <strong>{entry.name}</strong>
          {musical && <span className="sound-key-chip" data-sound-key={musical.short} title={keyTitle}>{musical.short}</span>}
        </span>
        <span className="sound-meta">{busy ? 'Loading' : meta}</span>
      </button>
      <FavoriteStar name={entry.name} pressed={starred} onToggle={onStar} />
      {shelf === 'drum' && onPad && (
        <button type="button" className="sound-add" aria-label={`Use ${entry.name} on pad`} disabled={busy} onClick={onPad}>Pad</button>
      )}
      {shelf && onTrack && (
        <button type="button" className="sound-add" aria-label={`Add ${entry.name} to track`} disabled={busy} onClick={onTrack}>Track</button>
      )}
      {!shelf && <button type="button" className="sound-add" aria-label={`Load ${entry.name}`} disabled={busy} onClick={onLoad}>Load</button>}
    </div>
  )
}

function memoryKeys(items: { id: string; legacyId?: string; library?: { key?: string } }[]) {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.library?.key || (item.id.startsWith('sound:') ? item.id.slice(6) : item.id.startsWith('library:') ? item.id.slice(8) : item.legacyId || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

export function LibraryAddSounds({
  open,
  category,
  bpm,
  musicalKey,
  message,
  busy,
  fileRef,
  onToggle,
  onCategory,
  onBpm,
  onKey,
  onSubmit,
}: {
  open: boolean
  category: string
  bpm: string
  musicalKey: string
  message: string
  busy: boolean
  fileRef: RefObject<HTMLInputElement | null>
  onToggle: () => void
  onCategory: (value: string) => void
  onBpm: (value: string) => void
  onKey: (value: string) => void
  onSubmit: (event: FormEvent) => void
}) {
  return (
    <>
      <div className="library-add-row">
        <button type="button" className="library-add-btn" aria-expanded={open} onClick={onToggle}>Add sounds</button>
      </div>
      {open && (
        <form className="library-add-form" data-add-sounds="open" onSubmit={onSubmit}>
          <input ref={fileRef} type="file" accept=".wav,audio/wav,audio/wave,audio/x-wav" multiple aria-label="WAV files" />
          <input aria-label="Sound category" placeholder="Category" value={category} onChange={(event) => onCategory(event.target.value)} />
          <input aria-label="Sound BPM" inputMode="decimal" placeholder="BPM" value={bpm} onChange={(event) => onBpm(event.target.value)} />
          <input aria-label="Sound key" placeholder="Key" value={musicalKey} onChange={(event) => onKey(event.target.value)} />
          <button type="submit" className="library-add-btn" disabled={busy}>Upload</button>
          {message ? <p className="sound-status">{message}</p> : null}
        </form>
      )}
    </>
  )
}

const LIBRARY_LANES: { id: LibraryLane; label: string }[] = [
  { id: 'loops', label: 'Loops' },
  { id: 'drums', label: 'Drums' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'oneshots', label: 'One-shots' },
  { id: 'sfx', label: 'SFX' },
  { id: 'favorites', label: 'Favorites' },
]

/** Chips directly under Search. Drums opens the drum shelves. Loops opens the loop shelves. */
export function LibraryLanes({ lane, onPick }: { lane: LibraryLane; onPick: (id: LibraryLane) => void }) {
  return (
    <div className="library-chip-scroll library-lanes" role="group" aria-label="Library">
      {LIBRARY_LANES.map((item) => (
        <button
          key={item.id}
          type="button"
          data-lane={item.id}
          className={lane === item.id ? 'on' : ''}
          aria-pressed={lane === item.id}
          onClick={() => onPick(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function FastShelf({
  mode,
  model,
  category,
  sub,
  genre,
  sort,
  nearTempo,
  inKey,
  compatible,
  songKey,
  stuck,
  tempoCenter,
  onCategory,
  onSub,
  onGenre,
  onSort,
  onNearTempo,
  onTempo,
  onInKey,
  onCompatible,
  onJump,
  onStep,
  onToggleStuck,
}: {
  mode: 'drum' | 'loop'
  model: ReturnType<typeof buildFastRows>
  category: string
  sub: DrumSub | ''
  genre: string
  sort: FastSort
  nearTempo: boolean
  inKey: boolean
  compatible: boolean
  songKey: string
  stuck: string
  tempoCenter: number
  onCategory: (id: string) => void
  onSub: (id: DrumSub | '') => void
  onGenre: (id: string) => void
  onSort: (sort: FastSort) => void
  onNearTempo: () => void
  onTempo: (center: number) => void
  onInKey: () => void
  onCompatible: () => void
  onJump: (id: string) => void
  onStep: (dir: number) => void
  onToggleStuck: () => void
}) {
  const focus = model.rows.find((row) => row.kind === 'sound')
  return (
    <div className="fast-shelf" data-fast-shelf={mode}>
      <div className="library-chip-scroll fast-chips" role="group" aria-label={mode === 'drum' ? 'Drum categories' : 'Loop categories'}>
        {model.chips.map((chip) => (
          <button
            key={chip.id || 'all'}
            type="button"
            data-drum-chip={mode === 'drum' ? chip.id || 'all' : undefined}
            data-loop-chip={mode === 'loop' ? chip.id || 'all' : undefined}
            className={`filter-choice${category === chip.id ? ' on' : ''}`}
            aria-pressed={category === chip.id}
            onClick={() => onCategory(chip.id)}
          >
            {chip.label} {chip.count}
          </button>
        ))}
      </div>
      {model.subs.length > 0 && (
        <div className="library-chip-scroll fast-chips" role="group" aria-label={category === 'hat' ? 'Hi-hat. Closed or open.' : 'Cymbal. Crash or ride.'}>
          {model.subs.map((chip) => (
            <button key={chip.id || 'all-sub'} type="button" className={`filter-choice${sub === chip.id ? ' on' : ''}`} aria-pressed={sub === chip.id} onClick={() => onSub(chip.id as DrumSub | '')}>{chip.label} {chip.count}</button>
          ))}
        </div>
      )}
      {mode === 'loop' && (
        <>
          {model.genres.length > 0 && (
            <div className="library-chip-scroll fast-chips" role="group" aria-label="Genres">
              {model.genres.map((chip) => (
                <button key={chip.id} type="button" data-genre-chip={chip.id} className={`filter-choice${genre === chip.id ? ' on' : ''}`} aria-pressed={genre === chip.id} onClick={() => onGenre(chip.id)}>{chip.label} {chip.count}</button>
              ))}
            </div>
          )}
          <div className="fast-tools" role="group" aria-label="Loop tempo, key, and sort">
            <button type="button" className={`filter-choice${nearTempo ? ' on' : ''}`} aria-pressed={nearTempo} onClick={onNearTempo}>Near tempo</button>
            <label className="fast-tempo">Tempo
              <input aria-label="Tempo window" type="range" min={60} max={200} step={1} value={Math.min(200, Math.max(60, tempoCenter))} onChange={(event) => onTempo(Number(event.target.value))} />
            </label>
            <button type="button" className={`filter-choice${inKey ? ' on' : ''}`} aria-pressed={inKey} onClick={onInKey}>In {songKey}</button>
            <button type="button" className={`filter-choice${compatible ? ' on' : ''}`} aria-pressed={compatible} onClick={onCompatible}>Compatible</button>
            {(['name', 'bpm', 'key'] as const).map((id) => (
              <button key={id} type="button" className={`filter-choice${sort === id ? ' on' : ''}`} aria-pressed={sort === id} onClick={() => onSort(id)}>{id === 'bpm' ? 'BPM' : id === 'key' ? 'Key' : 'Name'}</button>
            ))}
          </div>
        </>
      )}
      {stuck && (
        <button type="button" className="fast-section fast-stuck" onClick={onToggleStuck}>{stuck}</button>
      )}
      {focus?.entry && (
        <div className="fast-audition" role="group" aria-label="Audition">
          <button type="button" onClick={() => onStep(-1)}>Previous</button>
          <button type="button" onClick={() => onStep(1)}>Next</button>
          <button type="button" onClick={() => onJump(model.jump[0]?.id || focus.id)}>{model.jump.length ? 'Jump' : 'Top'}</button>
        </div>
      )}
    </div>
  )
}

function KeyPicker({
  query,
  project,
  onPick,
  onCompatible,
}: {
  query: LibraryQuery
  project: MusicalKey
  onPick: (value: string) => void
  onCompatible: () => void
}) {
  const selected = query.musicalKey === 'project' ? project.label : query.musicalKey
  return (
    <div className="library-key-picker" role="group" aria-label="Key">
      <div className="library-key-actions">
        <button type="button" className={`filter-choice library-key-project${query.musicalKey === 'project' ? ' on' : ''}`} data-value="project" aria-label="Project key" aria-pressed={query.musicalKey === 'project'} title={`Filter to the song key, ${project.label}.`} onClick={() => onPick('project')}>
          Project · {project.short}
        </button>
        <button type="button" className={`filter-choice${!query.musicalKey ? ' on' : ''}`} data-value="any" aria-pressed={!query.musicalKey} onClick={() => onPick('')}>Any key</button>
        <button type="button" className={`filter-choice${query.keyCompatible ? ' on' : ''}`} data-value="compatible" aria-label="Also relative" aria-pressed={query.keyCompatible === true} title="Also show the relative major or minor, and the parallel key." onClick={onCompatible}>Relative</button>
      </div>
      <p className="filter-label">Major</p>
      <div className="library-key-grid" role="group" aria-label="Major keys">
        {KEY_TONICS.map((name) => {
          const label = `${name} major`
          return (
            <button key={label} type="button" data-value={label} className={`filter-choice${selected === label ? ' on' : ''}`} aria-label={label} aria-pressed={selected === label} onClick={() => onPick(label)}>{name}</button>
          )
        })}
      </div>
      <p className="filter-label">Minor</p>
      <div className="library-key-grid" role="group" aria-label="Minor keys">
        {KEY_TONICS.map((name) => {
          const label = `${name} minor`
          return (
            <button key={label} type="button" data-value={label} className={`filter-choice${selected === label ? ' on' : ''}`} aria-label={label} aria-pressed={selected === label} onClick={() => onPick(label)}>{name}m</button>
          )
        })}
      </div>
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
  if (group === 'key') return Boolean(query.musicalKey)
  return Boolean(selectedValue(group, query))
}

function chipOn(group: Group, query: LibraryQuery) {
  if (group === 'instrument') return Boolean(query.category || query.instrument)
  return groupActive(group, query)
}

function activeFilters(query: LibraryQuery, project: MusicalKey) {
  const rows: { id: string; label: string; clear: Partial<LibraryQuery> }[] = []
  if (query.type) rows.push({ id: 'type', label: contentTypeLabel(query.type), clear: { type: '' } })
  if (query.category) rows.push({ id: 'category', label: chipLabel(query.category), clear: { category: '' } })
  if (query.instrument) rows.push({ id: 'instrument', label: chipLabel(query.instrument), clear: { instrument: '' } })
  if (query.genre) rows.push({ id: 'genre', label: chipLabel(query.genre), clear: { genre: '' } })
  if (query.musicalKey) {
    const parsed = query.musicalKey === 'project' ? project : parseMusicalKey(query.musicalKey)
    const name = query.musicalKey === 'project' ? `Project · ${project.short}` : (parsed?.short ?? query.musicalKey)
    const label = query.keyCompatible ? `${name} +rel` : name
    rows.push({ id: 'key', label, clear: { musicalKey: '', keyCompatible: false } })
  }
  if (query.mood) rows.push({ id: 'mood', label: chipLabel(query.mood), clear: { mood: '' } })
  if (query.pack) rows.push({ id: 'pack', label: query.pack, clear: { pack: '' } })
  if (query.bpmMin != null || query.bpmMax != null) {
    const label = query.bpmMin != null && query.bpmMax != null ? `${query.bpmMin}–${query.bpmMax} bpm` : query.bpmMin != null ? `${query.bpmMin}+ bpm` : `Under ${query.bpmMax} bpm`
    rows.push({ id: 'bpm', label, clear: { bpmMin: null, bpmMax: null } })
  }
  return rows
}
