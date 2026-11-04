import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { LibraryEntry } from '../audio/multisample/library'
import type { SamplePack } from '../audio/multisample/types'
import { decodeSlotFile, focusedSlot, SOUND_MIME } from '../audio/sample/slot'
import { uid } from '../model/types'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { catalogMessage, filterSounds, loadSoundCatalog } from '../sounds/catalog'
import { boundLibraryHost, filterStarters, loadStarterOnto, playableAudition, refreshStarterCatalog, starterCatalog } from '../sounds/instruments'
import { matchCountLabel, readSoundWidth, soundWidthFromDrag, writeSoundWidth } from '../sounds/panel'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor, trackIdFromDrop } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { CatalogResult, SoundEntry, SoundKind, SoundQuery } from '../sounds/types'
import { selectSounds } from '../state/select'
import type { ProjectStore } from '../state/store'
import './sound-browser.css'

const INSTRUMENT_PREFIX = 'instrument:'
let dragId = ''

const KIND_LABEL: Record<SoundKind, string> = {
  'one-shot': 'One-shot',
  loop: 'Loop',
  instrument: 'Instrument',
}

const LIST_CAP = 200
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
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
  holdLibraryPack?: (trackId: string, pack: SamplePack) => void
  auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
}

export function SoundBrowser({
  store,
  engine,
  phone,
  onClose,
  onWidth,
  reserve = 0,
  initial,
  instruments: instrumentSeed,
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
  const [starters, setStarters] = useState<LibraryEntry[]>(instrumentSeed ?? [])
  const [loading, setLoading] = useState(!initial)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [type, setType] = useState<SoundQuery['type']>(lockType && lockType !== 'all' ? lockType : 'all')
  useEffect(() => {
    setType(lockType && lockType !== 'all' ? lockType : 'all')
  }, [lockType])
  const [busy, setBusy] = useState('')
  const [playing, setPlaying] = useState('')
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
    if (instrumentSeed) return
    let alive = true
    void starterCatalog().then((next) => {
      if (!alive) return
      setStarters(next)
    }).catch(() => {
      /* the sound list still shows */
    })
    return () => { alive = false }
  }, [instrumentSeed])

  useEffect(() => () => engine.stopPreview(), [engine])

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
      const inner = target?.closest('.timeline-inner') as HTMLElement | null
      let at: number | undefined
      if (inner) {
        const px = Number(inner.dataset.px) || 90
        const rect = inner.getBoundingClientRect()
        at = Math.max(0, ((event.clientX - rect.left) / px) * (store.project.sampleRate || 48000))
      }
      addRef.current(entry, trackIdFromDrop(target), at)
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
    bpm: 'any',
    key: '',
    favoritesOnly: false,
    projectBpm: sounds.tempo,
    favorites: sounds.favorites,
  }
  const filtered = type === 'instrument' ? [] : filterSounds(result.entries, query)
  const starterRows = filterStarters(starters, query)
  const shownSounds = filtered.slice(0, LIST_CAP)
  const shown = shownSounds.length + starterRows.length
  const total = filtered.length + starterRows.length
  const queryActive = Boolean(text || type !== 'all')
  const offline = failed || result.status === 'missing'
  const message = loading && !shown
    ? 'Loading'
    : shown
      ? ''
      : offline
        ? catalogMessage({ entries: result.entries, status: 'missing' }, 0, false)
        : catalogMessage(result, 0, queryActive || type === 'instrument')
  const selected = store.project.tracks.find((track) => track.id === store.selectedTrackId) ?? null
  const where = selected?.type === 'midi'
    ? `Loads onto ${selected.name}.`
    : selected?.type === 'audio'
      ? `Adds to ${selected.name} at the playhead.`
      : sounds.trackId
        ? `Adds to ${sounds.trackName} at the playhead.`
        : 'Adds on a new track.'
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
    try {
      setStarters(await until(refreshStarterCatalog(), CATALOG_WAIT_MS))
    } catch { /* keep the instruments already on screen */ }
    setLoading(false)
  }

  function audioTarget(trackId?: string | null) {
    const found = audioTrackFor(store.project, sounds.trackId, trackId)
    if (found) return found
    if (trackId) return null
    const ids = store.addTracks({ kind: 'audio', count: 1, instrument: 'none', input: 'mic', channels: 1, armed: false })
    return ids[0] ?? null
  }

  function instrumentTarget(trackId?: string | null) {
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'midi') return dropped.id
    if (dropped) return null
    if (sounds.instrumentId) return sounds.instrumentId
    const ids = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    return ids[0] ?? null
  }

  async function loadEntry(entry: SoundEntry) {
    const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
    return decodeSoundBytes(bytes)
  }

  async function preview(entry: SoundEntry) {
    if (playing === entry.id) {
      engine.stopPreview()
      setPlaying('')
      return
    }
    setBusy(entry.id)
    try {
      const decoded = await loadEntry(entry)
      const channels = previewChannelsFor(entry, decoded.channels, decoded.sampleRate, store.project, engine.currentTimelineSample())
      engine.previewPcm(channels, store.project.sampleRate)
      setPlaying(entry.id)
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not play that sound.', 'warn')
    } finally {
      setBusy('')
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
      store.toast('The host owns the arrangement.', 'warn')
      return
    }
    const dropped = trackId ? store.track(trackId) : null
    if (dropped?.type === 'midi' || (!trackId && selected?.type === 'midi')) {
      await playAsInstrument(entry, dropped?.type === 'midi' ? dropped.id : selected?.id)
      return
    }
    const target = audioTarget(trackId)
    if (!target) {
      store.toast('Could not add a track for that sound.', 'warn')
      return
    }
    setBusy(entry.id)
    try {
      const decoded = await loadEntry(entry)
      const placed = placeSound({
        entry,
        channels: decoded.channels,
        fileRate: decoded.sampleRate,
        project: store.project,
        startSample: startSample ?? engine.currentTimelineSample(),
        bufferId: `lib_${entry.id}`,
      })
      if (!placed) {
        store.toast('That sound had no audio.', 'warn')
        return
      }
      if (!store.buffers.has(placed.asset.id)) store.addAsset(placed.asset)
      store.addAudioClip(target, placed.clip)
      const conformed = entry.type === 'loop' && placed.clip.stretch?.followTempo
      store.toast(conformed ? `${entry.name} is on the track at the song tempo.` : `${entry.name} is on the track.`, 'good')
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not add that sound.', 'warn')
    } finally {
      setBusy('')
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
    try {
      const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
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
  const instrumentHint = selected?.type === 'midi'
    ? `Load it on this track and play a note. ${where}`
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
      title={phone ? 'Tap a row to preview. Add puts it on the selected track.' : 'Drag a sound onto a track, or tap Add.'}
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
      </div>
      {!embedded && !lockType && (
        <div className="sound-chips" role="group" aria-label="Kind">
          {KIND_CHIPS.map((chip) => (
            <button key={chip.id} type="button" className={type === chip.id ? 'on' : ''} aria-pressed={type === chip.id} onClick={() => setType(chip.id)}>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      {message && (
        <p className="sound-status" role="status">
          {message}
          {!loading && (failed || result.status === 'missing') && (
            <button type="button" onClick={() => void reload()}>Retry</button>
          )}
        </p>
      )}
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
                  setPlaying(on ? '' : entry.id)
                  if (on) engine.stopPreview()
                  else void loadInstrument(entry, null, true)
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
                aria-label={`Add. ${instrumentHint}`}
                title={instrumentHint}
                onClick={() => { engine.unlock(); void loadInstrument(entry, null, true) }}
              >
                Add
              </button>
            </div>
          )
        })}
        {shownSounds.map((entry) => {
          const on = playing === entry.id
          const playHint = entry.type === 'loop' ? 'Play on the speakers at the song tempo.' : 'Play this sound on the speakers.'
          const credit = `${entry.license} · ${entry.source || 'Source not listed'}`
          return (
            <div className={`sound-row${on ? ' is-playing' : ''}`} key={entry.id}>
              <button
                type="button"
                className="sound-copy"
                draggable={!phone}
                aria-pressed={on}
                title={`${playHint} ${credit}. Hugging Face.`}
                disabled={busy === entry.id}
                onDragStart={(event) => beginDrag(entry.id, entry.name, event)}
                onDragEnd={() => { dragId = ''; window.setTimeout(() => { dragMoved.current = false }, 0) }}
                onClick={() => {
                  if (dragMoved.current) return
                  engine.unlock()
                  void preview(entry)
                }}
              >
                {on && <i className="sound-live" aria-hidden="true" />}
                <strong>{entry.name}</strong>
                <span className="sound-meta">{on ? 'Playing' : KIND_LABEL[entry.type]}</span>
              </button>
              <button
                type="button"
                className="sound-add"
                disabled={busy === entry.id || store.remoteFollow}
                aria-label={`Add. ${where}`}
                title={where}
                onClick={() => { engine.unlock(); void add(entry) }}
              >
                Add
              </button>
            </div>
          )
        })}
      </div>
      {count && <p className="sound-count">{count}</p>}
    </div>
  )

  if (embedded) return panel

  if (phone) {
    return (
      <div className="sound-back sheet">
        <button type="button" className="sound-dismiss" aria-label="Close sounds" title="Close the sound browser." onClick={onClose} />
        {panel}
      </div>
    )
  }

  return (
    <aside className="sound-slot" data-sound-panel="open">
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
