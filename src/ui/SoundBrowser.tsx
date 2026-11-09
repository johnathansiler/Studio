import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { fetchInstrument, type LibraryEntry } from '../audio/multisample/library'
import { libraryBaseUrl } from '../audio/multisample/source'
import type { SamplePack } from '../audio/multisample/types'
import { decodeSlotFile, focusedSlot, SOUND_MIME } from '../audio/sample/slot'
import { uid } from '../model/types'
import { soundCache } from '../sounds/cache'
import { browserSounds, catalogMessage, fetchCatalogSound, loadSoundCatalog, soundCategories, soundCollections, soundKeys, soundRoles, soundTags } from '../sounds/catalog'
import { boundLibraryHost, filterStarters, loadStarterOnto, playableAudition } from '../sounds/instruments'
import { matchCountLabel, readSoundWidth, soundWidthFromDrag, writeSoundWidth } from '../sounds/panel'
import { loopBarCount, waveformPeaks } from '../model/playheadPlace'
import { quartersPerBar } from '../model/time'
import { decodeSoundBytes, placeSound, previewChannelsFor, trackIdFromDrop } from '../sounds/place'
import { PACK_LABEL, packLabel } from '../sounds/contract'
import { importPrivateLibrary, type PrivateImportResult, type PrivateSourceFile } from '../sounds/private'
import { roleLabel } from '../sounds/roles'
import type { CatalogResult, SoundEntry, SoundFilter, SoundKind, SoundQuery } from '../sounds/types'
import { useFormFactor } from './form'
import { selectSounds } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'
import './sound-browser.css'

export function SoundFilterButton({
  bpm,
  soundKey,
  favoritesOnly,
  keys,
  showTempoKey,
  onBpm,
  onKey,
  onFavorites,
  collections = [],
  categories = [],
  collection = '',
  category = '',
  collectionLabels,
  tags = [],
  tag = '',
  onTag,
  onCollection,
  onCategory,
  roles = [],
  role = '',
  onRole,
  showKind = false,
  kind = 'all',
  onKind,
}: {
  bpm: SoundQuery['bpm']
  soundKey: string
  favoritesOnly: boolean
  keys: string[]
  showTempoKey: boolean
  onBpm: (bpm: SoundQuery['bpm']) => void
  onKey: (key: string) => void
  onFavorites: (value: boolean) => void
  collections?: string[]
  categories?: string[]
  collection?: string
  category?: string
  collectionLabels?: Record<string, string>
  tags?: string[]
  tag?: string
  onTag?: (value: string) => void
  onCollection?: (value: string) => void
  onCategory?: (value: string) => void
  roles?: string[]
  role?: string
  onRole?: (value: string) => void
  showKind?: boolean
  kind?: SoundFilter
  onKind?: (value: SoundFilter) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const summary = [bpm === 'project' ? 'Song tempo' : '', soundKey, collectionLabels?.[collection] ?? collection, category, role ? roleLabel(role) : '', tag, favoritesOnly ? 'Favorites' : ''].filter(Boolean).join(', ')
  const filtering = bpm !== 'any' || Boolean(soundKey || favoritesOnly || collection || category || tag || role)
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`sound-filter${filtering ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={summary ? `Filter. ${summary}.` : 'Filter. Kind, role, pack, tag, category, tempo, key, and favorites.'}
        title="Kind, role, pack, tag, category, tempo, key, and favorites."
        onClick={() => setOpen((value) => !value)}
      >
        Filter
      </button>
      <AnchoredMenu className="sound-filter-menu" open={open} onClose={() => setOpen(false)} label="Filter" triggerRef={buttonRef}>
        {showKind && onKind && (
          <>
            <p className="filter-label">Kind</p>
            <div className="filter-row" role="group" aria-label="Kind. One-shots, loops, or drums.">
              {KIND_CHIPS.filter((chip) => chip.id !== 'instrument').map((chip) => (
                <button key={chip.id} type="button" className={`filter-choice${kind === chip.id ? ' on' : ''}`} aria-pressed={kind === chip.id} onClick={() => onKind(chip.id)}>{chip.label}</button>
              ))}
            </div>
          </>
        )}
        {collections.length > 0 && onCollection && (
          <>
            <p className="filter-label">Pack</p>
            <div className="filter-row" role="group" aria-label="Pack.">
              <button type="button" className={`filter-choice${!collection ? ' on' : ''}`} aria-pressed={!collection} onClick={() => onCollection('')}>Any pack</button>
              {collections.map((item) => (
                <button key={item} type="button" className={`filter-choice${collection === item ? ' on' : ''}`} aria-pressed={collection === item} onClick={() => onCollection(item)}>{collectionLabels?.[item] ?? item}</button>
              ))}
            </div>
          </>
        )}
        {roles.length > 0 && onRole && (
          <>
            <p className="filter-label">Role</p>
            <div className="filter-row" role="group" aria-label="Role. Loop, drum one-shot, and other catalog roles.">
              <button type="button" className={`filter-choice${!role ? ' on' : ''}`} aria-pressed={!role} onClick={() => onRole('')}>Any role</button>
              {roles.map((item) => (
                <button key={item} type="button" className={`filter-choice${role === item ? ' on' : ''}`} aria-pressed={role === item} onClick={() => onRole(item)}>{roleLabel(item)}</button>
              ))}
            </div>
          </>
        )}
        {tags.length > 0 && onTag && (
          <>
            <p className="filter-label">Tag</p>
            <div className="filter-row" role="group" aria-label="Tag. Instrument, role, and other labels from the catalog.">
              <button type="button" className={`filter-choice${!tag ? ' on' : ''}`} aria-pressed={!tag} onClick={() => onTag('')}>Any tag</button>
              {tags.map((item) => (
                <button key={item} type="button" className={`filter-choice${tag === item ? ' on' : ''}`} aria-pressed={tag === item} onClick={() => onTag(item)}>{item}</button>
              ))}
            </div>
          </>
        )}
        {categories.length > 0 && onCategory && (
          <>
            <p className="filter-label">Category</p>
            <div className="filter-row" role="group" aria-label="Category.">
              <button type="button" className={`filter-choice${!category ? ' on' : ''}`} aria-pressed={!category} onClick={() => onCategory('')}>Any category</button>
              {categories.map((item) => (
                <button key={item} type="button" className={`filter-choice${category === item ? ' on' : ''}`} aria-pressed={category === item} onClick={() => onCategory(item)}>{item.charAt(0).toUpperCase() + item.slice(1)}</button>
              ))}
            </div>
          </>
        )}
        {showTempoKey && (
          <>
            <p className="filter-label">Tempo</p>
            <div className="filter-row" role="group" aria-label="Tempo. Loops near the song tempo, including half-time and double-time.">
              <button type="button" className={`filter-choice${bpm === 'any' ? ' on' : ''}`} aria-pressed={bpm === 'any'} title="Loops near the song tempo, including half-time and double-time." onClick={() => onBpm('any')}>Any tempo</button>
              <button type="button" className={`filter-choice${bpm === 'project' ? ' on' : ''}`} aria-pressed={bpm === 'project'} title="Loops near the song tempo, including half-time and double-time." onClick={() => onBpm('project')}>Song tempo</button>
            </div>
            <p className="filter-label">Key</p>
            <div className="filter-row" role="group" aria-label="Key. Only sounds in this key.">
              <button type="button" className={`filter-choice${!soundKey ? ' on' : ''}`} aria-pressed={!soundKey} title="Only sounds in this key." onClick={() => onKey('')}>Any key</button>
              {keys.map((item) => (
                <button key={item} type="button" className={`filter-choice${soundKey === item ? ' on' : ''}`} aria-pressed={soundKey === item} title="Only sounds in this key." onClick={() => onKey(item)}>{item}</button>
              ))}
            </div>
          </>
        )}
        <p className="filter-label">Favorites</p>
        <div className="filter-row">
          <button
            type="button"
            className={`filter-choice${favoritesOnly ? ' on' : ''}`}
            aria-pressed={favoritesOnly}
            title="Only sounds saved in this project."
            onClick={() => onFavorites(!favoritesOnly)}
          >
            Favorites
          </button>
        </div>
      </AnchoredMenu>
    </>
  )
}

const INSTRUMENT_PREFIX = 'instrument:'
let dragId = ''

/** Folder, zip, or loose files the user picks. Nothing here runs until that pick. */
export function PrivateLibraryButton({ onDone }: { onDone: (message: string, changed: boolean) => void }) {
  const phone = useFormFactor() === 'phone'
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  async function install(list: FileList) {
    setOpen(false)
    onDone('Reading the chosen files…', false)
    try {
      const sources: PrivateSourceFile[] = []
      for (const file of list) {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        sources.push({ name: file.name, relativePath, read: () => file.arrayBuffer() })
      }
      const result: PrivateImportResult = await importPrivateLibrary(sources)
      onDone(result.message, !result.keptPrevious)
    } catch (error) {
      onDone(error instanceof Error ? error.message : 'The import did not finish. The library already on this device was kept.', false)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sound-filter"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Add a private library from this device. Files stay in this browser."
        title="Add a folder, zip, or catalog from this device. The files stay in this browser and are not uploaded."
        onClick={() => setOpen((value) => !value)}
      >
        Add
      </button>
      <AnchoredMenu className="sound-filter-menu" open={open} onClose={() => setOpen(false)} label="Add private sounds" triggerRef={buttonRef}>
        <button type="button" className="filter-choice" onClick={() => zipRef.current?.click()}>Zip or files</button>
        {!phone && <button type="button" className="filter-choice" onClick={() => folderRef.current?.click()}>Folder</button>}
        <p className="filter-label">{phone ? 'Choose a zip you already saved. A phone does not import a whole library by itself.' : 'The files stay on this device. They are not uploaded.'}</p>
      </AnchoredMenu>
      <input
        ref={zipRef}
        className="chop-file"
        type="file"
        accept=".wav,.json,.zip,audio/wav,application/zip,application/json"
        multiple
        hidden
        aria-label="Add a private zip or files from this device"
        onChange={(event) => {
          const list = event.target.files
          event.target.value = ''
          if (!list?.length) return
          void install(list)
        }}
      />
      {!phone && (
        <input
          ref={folderRef}
          className="chop-file"
          type="file"
          multiple
          hidden
          aria-label="Add a private library folder from this device"
          {...{ webkitdirectory: '', directory: '' }}
          onChange={(event) => {
            const list = event.target.files
            event.target.value = ''
            if (!list?.length) return
            void install(list)
          }}
        />
      )}
    </>
  )
}

const KIND_LABEL: Record<SoundKind, string> = {
  'one-shot': 'One-shot',
  loop: 'Loop',
  instrument: 'Instrument',
}

const CATALOG_WAIT_MS = 8000

const KIND_CHIPS: { id: SoundQuery['type']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'one-shot', label: 'One-shots' },
  { id: 'loop', label: 'Loops' },
  { id: 'drum', label: 'Drums' },
  { id: 'instrument', label: 'Instruments' },
]

function until<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('Could not load sounds.'))
      },
    )
  })
}

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number, loop?: boolean) => void
  currentTimelineSample: () => number
  decodeLibrary?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>
  previewHead?: (now?: number) => { ratio: number; loop: boolean; duration: number; done: boolean } | null
  holdLibraryPack?: (trackId: string, pack: SamplePack) => void
  auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
}

/** Bring the new Arrange clip into the timeline, including when a phone sheet has shortened the lanes. */
export function revealArrangedClip(trackId: string, clipId: string) {
  const show = () => {
    const clip = document.querySelector(`[data-clip="${CSS.escape(clipId)}"]`) as HTMLElement | null
    const timeline = document.querySelector('.timeline-scroll') as HTMLElement | null
    const heads = document.querySelector('.arrange .heads') as HTMLElement | null
    if (!timeline || !clip || clip.getAttribute('data-track') !== trackId) return false
    const view = timeline.getBoundingClientRect()
    const box = clip.getBoundingClientRect()
    const pad = 12
    if (box.top < view.top + pad || box.bottom > view.bottom - pad) timeline.scrollTop += box.top - view.top - pad
    if (box.left < view.left + pad || box.right > view.right - pad) timeline.scrollLeft += box.left - view.left - pad
    if (heads) heads.scrollTop = timeline.scrollTop
    return true
  }
  requestAnimationFrame(() => {
    if (!show()) requestAnimationFrame(show)
  })
}

export function SoundBrowser({
  store,
  engine,
  phone,
  onClose,
  onWidth,
  reserve = 0,
  initial,
  embedded = false,
  lockType,
}: {
  store: ProjectStore
  engine: PreviewEngine
  phone: boolean
  onClose: () => void
  /** Desktop column width. Phones use a sheet and ignore this. */
  onWidth?: (px: number) => void
  /** Pixels already used by the side dock, so the column leaves the timeline room. */
  reserve?: number
  /** Tests pass a catalog so the panel can render without the network. */
  initial?: CatalogResult
  instruments?: LibraryEntry[]
  /** Inside the Arrange browser. The parent draws the frame and the resize handle. */
  embedded?: boolean
  /** Sounds, Instruments, or Loops tab. Hides the kind menu. */
  lockType?: SoundQuery['type']
}) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const sounds = selectSounds(store)
  const [result, setResult] = useState<CatalogResult>(initial ?? { entries: [], status: 'missing' })
  const [starters] = useState<LibraryEntry[]>([])
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(!initial)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [type, setType] = useState<SoundQuery['type']>(lockType && lockType !== 'all' ? lockType : 'all')
  const [bpm, setBpm] = useState<SoundQuery['bpm']>('any')
  const [soundKey, setSoundKey] = useState('')
  const [collection, setCollection] = useState('')
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [role, setRole] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [loadRatio, setLoadRatio] = useState(0)
  const [privateNote, setPrivateNote] = useState('')
  useEffect(() => {
    setType(lockType && lockType !== 'all' ? lockType : 'all')
  }, [lockType])
  const [busy, setBusy] = useState('')
  const [fault, setFault] = useState('')
  const [playing, setPlaying] = useState('')
  const [wave, setWave] = useState<{ id: string; peaks: number[]; bars: number } | null>(null)
  const [head, setHead] = useState(0)
  const entriesRef = useRef(result.entries)
  const startersRef = useRef(starters)
  const addRef = useRef<(entry: SoundEntry, trackId?: string | null, startSample?: number) => void>(() => undefined)
  const loadRef = useRef<(entry: LibraryEntry, trackId?: string | null) => void>(() => undefined)
  const slotRef = useRef<(entry: SoundEntry) => void>(() => undefined)
  entriesRef.current = result.entries
  startersRef.current = starters

  useEffect(() => {
    if (initial) return
    let alive = true
    setLoading(true)
    setFailed(false)
    void until(loadSoundCatalog(fetch, soundCache()), CATALOG_WAIT_MS).then((next) => {
      if (!alive) return
      setResult(next)
      setFailed(false)
      setLoading(false)
    }).catch(() => {
      if (!alive) return
      setResult({ entries: [], status: 'missing' })
      setFailed(true)
      setLoading(false)
    })
    return () => { alive = false }
  }, [initial])

  useEffect(() => {
    setPage(0)
  }, [text, type, bpm, soundKey, collection, category, tag, role, favoritesOnly])

  useEffect(() => () => engine.stopPreview(), [engine])
  useEffect(() => {
    if (!playing || !engine.previewHead) return
    let frame = 0
    const tick = () => {
      const next = engine.previewHead?.()
      if (next?.done) {
        setPlaying('')
        setHead(0)
        return
      }
      if (next) setHead(next.ratio)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, engine])

  useEffect(() => {
    if (embedded) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [embedded, onClose])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const allow = (event: DragEvent) => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes(SOUND_MIME) && !dragId) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const drop = (event: DragEvent) => {
      const id = event.dataTransfer?.getData(SOUND_MIME) || dragId
      if (!id) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.sound-panel, .sound-slot, .playlist-browser, [data-pads]')) return
      event.preventDefault()
      dragId = ''
      if (id.startsWith(INSTRUMENT_PREFIX)) {
        const starter = startersRef.current.find((item) => item.id === id.slice(INSTRUMENT_PREFIX.length))
        if (starter) loadRef.current(starter, trackIdFromDrop(target))
        return
      }
      const entry = entriesRef.current.find((item) => item.id === id)
      if (!entry) return
      const droppedId = trackIdFromDrop(target)
      const dropped = droppedId ? store.track(droppedId) : null
      if (dropped?.type === 'midi') {
        void playAsInstrument(entry, dropped.id)
        return
      }
      if (target?.closest('[data-slot-drop]')) {
        slotRef.current(entry)
        return
      }
      addRef.current(entry, trackIdFromDrop(target), engine.currentTimelineSample())
    }
    window.addEventListener('dragover', allow)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', allow)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const query: SoundQuery = {
    text,
    type,
    bpm,
    key: soundKey,
    favoritesOnly,
    projectBpm: sounds.tempo,
    favorites: sounds.favorites,
    collection,
    category,
    tag,
    role,
  }
  const playOnKeys = type === 'instrument'
  const filtered = browserSounds(result.entries, query)
  const starterRows = filterStarters(starters, query)
  const pageSize = 60
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const shownSounds = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize)
  const shown = shownSounds.length + starterRows.length
  const total = filtered.length + starterRows.length
  const queryActive = Boolean(text || type !== 'all' || bpm !== 'any' || soundKey || collection || category || tag || role || favoritesOnly)
  const keys = soundKeys(result.entries)
  const collections = soundCollections(result.entries)
  const categories = soundCategories(result.entries)
  const tags = soundTags(result.entries)
  const roles = soundRoles(result.entries)
  const offline = failed || result.status === 'missing'
  const message = loading && !shown
    ? 'Loading'
    : shown
      ? ''
      : offline
        ? catalogMessage({ entries: result.entries, status: 'missing' }, 0, false)
        : catalogMessage(result, 0, queryActive || type === 'instrument')
  const selected = store.project.tracks.find((track) => track.id === store.selectedTrackId) ?? null
  const where = playOnKeys
    ? 'Loads this file as one sample on the keyboard. It is not a multisampled instrument.'
    : selected?.type === 'audio'
      ? `Adds to ${selected.name} at the playhead.`
      : 'Adds on a new audio track at the playhead.'
  const instrumentWhere = selected?.type === 'midi'
    ? `Loads onto ${selected.name}.`
    : 'Loads onto an instrument track.'
  const count = matchCountLabel(total, shown)

  async function reload() {
    setLoading(true)
    setFailed(false)
    try {
      const next = await until(loadSoundCatalog(fetch, soundCache()), CATALOG_WAIT_MS)
      setResult(next)
      setFailed(false)
    } catch {
      setResult({ entries: [], status: 'missing' })
      setFailed(true)
    }
    setLoading(false)
  }

  function audioTarget(trackId?: string | null) {
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'audio') return dropped.id
    if (trackId) return null
    const selected = store.project.tracks.find((track) => track.id === store.selectedTrackId)
    if (selected?.type === 'audio') return selected.id
    return null
  }

  function instrumentTarget(trackId?: string | null) {
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'midi') return dropped.id
    if (dropped) return null
    if (sounds.instrumentId) return sounds.instrumentId
    const ids = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    return ids[0] ?? null
  }

  const previewAbort = useRef<AbortController | null>(null)
  async function loadEntry(entry: SoundEntry, signal?: AbortSignal) {
    setLoadRatio(0)
    const bytes = await fetchCatalogSound(entry, { onProgress: setLoadRatio, signal })
    if (engine.decodeLibrary) return engine.decodeLibrary(bytes)
    return decodeSoundBytes(bytes)
  }

  async function preview(entry: SoundEntry) {
    if (playing === entry.id) {
      previewAbort.current?.abort()
      previewGen.current += 1
      engine.stopPreview()
      setPlaying('')
      setWave(null)
      setHead(0)
      return
    }
    previewAbort.current?.abort()
    const controller = new AbortController()
    previewAbort.current = controller
    const gen = ++previewGen.current
    setBusy(entry.id)
    try {
      const decoded = await loadEntry(entry, controller.signal)
      if (gen !== previewGen.current || controller.signal.aborted) return
      const channels = previewChannelsFor(entry, decoded.channels, decoded.sampleRate, store.project, engine.currentTimelineSample())
      const lead = channels[0]
      engine.stopPreview()
      engine.previewPcm(channels, store.project.sampleRate, entry.type === 'loop')
      const seconds = lead?.length ? lead.length / store.project.sampleRate : 0
      setWave({
        id: entry.id,
        peaks: waveformPeaks(lead ?? new Float32Array()),
        bars: entry.type === 'loop' ? loopBarCount(seconds, store.project.tempo, quartersPerBar(store.project.timeSignature)) : 0,
      })
      setHead(0)
      setPlaying(entry.id)
    } catch (error) {
      if (gen !== previewGen.current || controller.signal.aborted) return
      store.toast(error instanceof Error ? error.message : 'Could not play that sound.', 'warn')
    } finally {
      if (gen === previewGen.current) setBusy('')
    }
  }

  async function playAsInstrument(entry: SoundEntry, trackId?: string | null) {
    if (store.remoteFollow) {
      store.toast('The host owns the arrangement.', 'warn')
      return
    }
    const target = instrumentTarget(trackId)
    if (!target) {
      store.toast('Instruments load onto an instrument track.', 'warn')
      return
    }
    setBusy(entry.id)
    try {
      const decoded = await loadEntry(entry)
      const lead = decoded.channels[0]
      if (!lead?.length) {
        store.toast('That sound had no audio.', 'warn')
        return
      }
      store.loadSamplerSound(target, {
        id: `lib_${entry.id}`,
        name: entry.name,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      }, undefined, entry.type === 'loop')
      store.toast(`${entry.name} plays across the keyboard.`, 'good')
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not load that sound.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function add(entry: SoundEntry, trackId?: string | null, startSample?: number) {
    if (store.remoteFollow) {
      const message = 'The host owns the arrangement.'
      setFault(message)
      store.toast(message, 'warn')
      return
    }
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'midi') {
      await playAsInstrument(entry, dropped.id)
      return
    }
    const gen = ++previewGen.current
    setBusy(entry.id)
    try {
      const decoded = await loadEntry(entry)
      const placed = placeSound({
        entry,
        channels: decoded.channels,
        fileRate: decoded.sampleRate,
        project: store.project,
        startSample: 0,
        bufferId: `lib_${entry.id}`,
      })
      if (!placed) {
        if (gen !== previewGen.current) return
        const message = 'That sound had no audio.'
        setFault(message)
        store.toast(message, 'warn')
        return
      }
      if (!store.buffers.has(placed.asset.id)) store.addAsset(placed.asset)
      const host = audioTarget(trackId)
      const at = startSample ?? engine.currentTimelineSample()
      const landed = store.placeClipAtPlayhead(host, placed.clip, at)
      const clip = landed ? store.project.tracks.find((track) => track.id === landed.trackId)?.clips.find((item) => item.id === landed.clipId) : null
      const channel = clip ? store.buffers.get(clip.bufferId)?.channels[0] : null
      if (!landed || !clip || clip.durationSamples < 1 || !channel?.length) {
        if (gen !== previewGen.current) return
        const message = 'Could not add that sound onto the track.'
        setFault(message)
        store.toast(message, 'warn')
        return
      }
      revealArrangedClip(landed.trackId, landed.clipId)
      if (gen !== previewGen.current) return
      setFault('')
      engine.stopPreview()
      setPlaying('')
      setWave(null)
      const conformed = entry.type === 'loop' && clip.stretch?.followTempo
      store.toast(conformed ? `${entry.name} is on the track at the song tempo.` : `${entry.name} is on the track.`, 'good')
    } catch (error) {
      if (gen !== previewGen.current) return
      const message = error instanceof Error ? error.message : 'Could not add that sound.'
      setFault(message)
      store.toast(message, 'warn')
    } finally {
      if (gen === previewGen.current) setBusy('')
    }
  }
  addRef.current = (entry, trackId, startSample) => {
    engine.unlock()
    void add(entry, trackId, startSample)
  }

  async function intoSlot(entry: SoundEntry) {
    const open = focusedSlot(store)
    if (!open) {
      store.toast('Open a sampler or looper first.', 'warn')
      return
    }
    setBusy(entry.id)
    setLoadRatio(0)
    try {
      const bytes = await fetchCatalogSound(entry, { onProgress: setLoadRatio })
      const decoded = await decodeSlotFile(bytes)
      if (!decoded.channels[0]?.length) {
        store.toast('That sound had no audio.', 'warn')
        return
      }
      store.loadSlotAudio(open.trackId, open.pluginId, {
        id: uid('smp'),
        name: entry.name,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      })
      store.toast(`${entry.name} is in the ${open.kind}.`, 'good')
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not load that sound.', 'warn')
    } finally {
      setBusy('')
    }
  }
  slotRef.current = (entry) => {
    engine.unlock()
    void intoSlot(entry)
  }

  async function previewInstrument(entry: LibraryEntry) {
    if (playing === entry.id) {
      previewGen.current += 1
      engine.stopPreview()
      setPlaying('')
      return
    }
    const gen = ++previewGen.current
    engine.stopPreview()
    const target = selected?.type === 'midi' ? selected.id : ''
    const loaded = target ? store.track(target)?.library : null
    if (target && loaded?.id === entry.id && engine.auditionLibrary) {
      setPlaying(entry.id)
      const choice = playableAudition(loaded)
      await engine.auditionLibrary(target, choice.pitch, choice.velocity)
      return
    }
    setBusy(entry.id)
    try {
      const imported = await fetchInstrument(libraryBaseUrl(), entry)
      if (gen !== previewGen.current) return
      const sample = imported.program.samples.find((item) => item.url)
      if (!sample?.url) {
        store.toast('Load places this instrument. Then play a note.', 'warn')
        return
      }
      const response = await fetch(sample.url)
      if (!response.ok) throw new Error(`${entry.name} has no preview.`)
      const bytes = await response.arrayBuffer()
      const decoded = engine.decodeLibrary ? await engine.decodeLibrary(bytes) : await decodeSoundBytes(bytes)
      if (gen !== previewGen.current) return
      engine.previewPcm(decoded.channels, decoded.sampleRate, false)
      setPlaying(entry.id)
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not preview that instrument.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function loadInstrument(entry: LibraryEntry, trackId?: string | null, audition = true) {
    if (store.remoteFollow) {
      store.toast('The host owns the arrangement.', 'warn')
      return
    }
    const dropped = trackId ? store.track(trackId) : null
    if (dropped && dropped.type !== 'midi') {
      store.toast('Instruments load onto an instrument track.', 'warn')
      return
    }
    const target = instrumentTarget(trackId)
    if (!target) {
      store.toast('Could not add an instrument track.', 'warn')
      return
    }
    const already = store.track(target)?.library?.id === entry.id
    setBusy(entry.id)
    try {
      if (already && audition && engine.auditionLibrary) {
        const program = store.track(target)?.library
        const choice = program ? playableAudition(program) : { pitch: 60, velocity: 0.9 }
        await engine.auditionLibrary(target, choice.pitch, choice.velocity)
      } else {
        await loadStarterOnto(entry, target, boundLibraryHost(engine, (id, program) => store.setLibrary(id, program), audition), { audition })
      }
      const name = store.track(target)?.name ?? 'the track'
      store.toast(`${entry.name} is on ${name}.`, 'good')
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not load that instrument.', 'warn')
    } finally {
      setBusy('')
    }
  }
  loadRef.current = (entry, trackId) => {
    engine.unlock()
    void loadInstrument(entry, trackId, true)
  }

  function resize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const origin = event.clientX
    const aside = reserve
    const start = readSoundWidth(undefined, window.innerWidth, aside)
    const move = (ev: PointerEvent) => {
      const next = soundWidthFromDrag(start, origin - ev.clientX, window.innerWidth, aside)
      onWidth?.(writeSoundWidth(next, undefined, window.innerWidth, aside))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragMoved = useRef(false)
  const previewGen = useRef(0)
  const instrumentHint = selected?.type === 'midi'
    ? `Load it on this track and play a note. ${instrumentWhere}`
    : 'Load it on this track and play a note.'

  function beginDrag(id: string, name: string, event: ReactDragEvent) {
    dragMoved.current = true
    dragId = id
    event.dataTransfer.setData(SOUND_MIME, id)
    event.dataTransfer.setData('text/plain', name)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const panel = (
    <div
      className="sound-panel"
      id="sound-browser"
      role="complementary"
      aria-label="Sounds. Loops, one-shots, and instruments from the free library."
      title={phone ? 'Tap a row to preview. Load puts it on the selected track.' : 'Drag a sound onto a track, or tap Load.'}
    >
      {!embedded && (
        <div className="sound-head">
          <h2>Sounds</h2>
          <button type="button" className="sound-close" onClick={onClose}>Close</button>
        </div>
      )}
      <div className="sound-filters">
        <input
          aria-label="Search sounds"
          placeholder="Search"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <PrivateLibraryButton onDone={(message, changed) => {
          setPrivateNote(message)
          if (!changed) return
          void loadSoundCatalog(fetch, soundCache()).then((next) => setResult(next)).catch(() => undefined)
        }} />
        <SoundFilterButton
          bpm={bpm}
          soundKey={soundKey}
          favoritesOnly={favoritesOnly}
          keys={keys}
          showTempoKey={type !== 'instrument'}
          onBpm={setBpm}
          onKey={setSoundKey}
          onFavorites={setFavoritesOnly}
          collections={collections}
          categories={categories}
          collection={collection}
          category={category}
          collectionLabels={PACK_LABEL}
          tags={tags}
          tag={tag}
          onTag={setTag}
          roles={roles}
          role={role}
          onRole={setRole}
          onCollection={setCollection}
          onCategory={setCategory}
        />
      </div>
      {type === 'drum' && (
        <p className="sound-status" role="status">These are drum one-shots. Loops stay under Loops. A pad with no downloaded one-shot keeps its built-in voice.</p>
      )}
      {!lockType && (
        <div className="sound-chips" role="group" aria-label="Kind">
          {(embedded ? KIND_CHIPS.filter((chip) => chip.id !== 'instrument') : KIND_CHIPS).map((chip) => (
            <button key={chip.id} type="button" className={type === chip.id ? 'on' : ''} aria-pressed={type === chip.id} onClick={() => setType(chip.id)}>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      {privateNote && <p className="sound-status" role="status">{privateNote}</p>}
      {message && (
        <p className="sound-status" role="status">
          {message}
          {!loading && (failed || result.status === 'missing') && (
            <button type="button" onClick={() => void reload()}>Retry</button>
          )}
        </p>
      )}
      {fault && <p className="sound-status" role="alert">{fault}</p>}
      <div className="sound-list">
        {starterRows.map((entry) => {
          const on = playing === entry.id
          const credit = `${entry.description} ${entry.license} · Hugging Face`
          return (
            <div className={`sound-row${on ? ' is-playing' : ''}`} key={entry.id}>
              <button
                type="button"
                className="sound-copy"
                draggable={!phone}
                aria-pressed={on}
                title={credit}
                disabled={busy === entry.id}
                onDragStart={(event) => beginDrag(`${INSTRUMENT_PREFIX}${entry.id}`, entry.name, event)}
                onDragEnd={() => { dragId = ''; window.setTimeout(() => { dragMoved.current = false }, 0) }}
                onClick={() => {
                  if (dragMoved.current) return
                  engine.unlock()
                  if (on) {
                    engine.stopPreview()
                    setPlaying('')
                  } else void previewInstrument(entry)
                }}
              >
                {on && <i className="sound-live" aria-hidden="true" />}
                <strong>{entry.name}</strong>
                <span className="sound-meta">{on ? 'Playing' : 'Instrument'}</span>
              </button>
              <button
                type="button"
                className="sound-add"
                disabled={busy === entry.id || store.remoteFollow}
                aria-label={`Load. ${instrumentHint}`}
                title={instrumentHint}
                onClick={() => { engine.unlock(); void loadInstrument(entry, null, true) }}
              >
                Load
              </button>
            </div>
          )
        })}
        {shownSounds.map((entry) => {
          const on = playing === entry.id
          const playHint = entry.type === 'loop' ? 'Play on the speakers at the song tempo.' : 'Play this sound on the speakers.'
          const credit = `${entry.license} · ${entry.source || 'Source not listed'}${entry.tags.length ? ` · ${entry.tags.join(', ')}` : ''}`
          const hosted = entry.origin === 'private' ? 'On this device. Not uploaded.' : 'Hugging Face.'
          const meta = busy === entry.id ? `Loading ${Math.round(loadRatio * 100)}%` : on ? 'Playing' : [entry.origin === 'private' ? 'Private' : '', KIND_LABEL[entry.type], entry.publisher, entry.pack ? packLabel(entry.pack) : '', entry.category && entry.category !== entry.type ? entry.category : '', entry.role ? roleLabel(entry.role) : ''].filter(Boolean).join(' · ')
          return (
            <div className={`sound-row${on ? ' is-playing' : ''}`} key={entry.id}>
              <button
                type="button"
                className="sound-copy"
                draggable={!phone}
                aria-pressed={on}
                title={`${playHint} ${credit}. ${hosted}`}
                disabled={busy === entry.id}
                onDragStart={(event) => beginDrag(entry.id, entry.name, event)}
                onDragEnd={() => { dragId = ''; window.setTimeout(() => { dragMoved.current = false }, 0) }}
                onClick={() => {
                  if (dragMoved.current) return
                  engine.unlock()
                  void preview(entry)
                }}
              >
                {on && wave?.id === entry.id && (
                  <span className="sound-wave" aria-hidden="true">
                    {wave.peaks.map((peak, index) => (
                      <i key={index} style={{ height: `${Math.max(12, peak * 100)}%` }} />
                    ))}
                    <b className="sound-shade" style={{ width: `${head * 100}%` }} />
                    <b className="sound-head" style={{ left: `${head * 100}%` }} />
                    {wave.bars > 1 && Array.from({ length: wave.bars - 1 }, (_, index) => (
                      <b key={index} className="sound-bar" style={{ left: `${((index + 1) / wave.bars) * 100}%` }} />
                    ))}
                  </span>
                )}
                <strong>{entry.name}</strong>
                <span className="sound-meta">{meta}</span>
              </button>
              <button
                type="button"
                className="sound-add"
                disabled={busy === entry.id || store.remoteFollow}
                aria-label={`Load. ${where}`}
                title={where}
                onClick={() => { engine.unlock(); void (playOnKeys ? playAsInstrument(entry) : add(entry)) }}
              >
                Load
              </button>
            </div>
          )
        })}
      </div>
      {count && <p className="sound-count">{count}{pageCount > 1 ? ` Page ${safePage + 1} of ${pageCount}.` : ''}</p>}
      {pageCount > 1 && (
        <div className="sound-chips" role="group" aria-label="More sounds">
          <button type="button" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>Previous</button>
          <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</button>
        </div>
      )}
    </div>
  )

  if (embedded) return panel

  if (phone) {
    return (
      <div className="sound-back sheet" aria-label="Sounds">
        <button type="button" className="sound-dismiss" aria-label="Close sounds" title="Close the sound browser." onClick={onClose} />
        {panel}
      </div>
    )
  }

  return (
    <aside className="sound-slot" data-sound-panel="open" aria-label="Sounds">
      <button
        type="button"
        className="sound-resize"
        aria-label="Sounds width. Drag to resize the sounds panel."
        title="Drag to resize the sounds panel."
        onPointerDown={resize}
      />
      {panel}
    </aside>
  )
}
