import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { LibraryEntry } from '../audio/multisample/library'
import type { SamplePack } from '../audio/multisample/types'
import { decodeSlotFile, focusedSlot, SOUND_MIME } from '../audio/sample/slot'
import { uid } from '../model/types'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { catalogMessage, filterSounds, loadSoundCatalog, soundKeys } from '../sounds/catalog'
import { boundLibraryHost, filterStarters, loadStarterOnto, playableAudition, refreshStarterCatalog, starterCatalog } from '../sounds/instruments'
import { matchCountLabel, readSoundWidth, soundWidthFromDrag, writeSoundWidth } from '../sounds/panel'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor, trackIdFromDrop } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { CatalogResult, SoundEntry, SoundKind, SoundQuery } from '../sounds/types'
import { selectSounds } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'
import './sound-browser.css'

const INSTRUMENT_PREFIX = 'instrument:'
let dragId = ''

const KIND_LABEL: Record<SoundKind, string> = {
  'one-shot': 'One-shot',
  loop: 'Loop',
  instrument: 'Instrument',
}

const LIST_CAP = 200

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
  const [startersReady, setStartersReady] = useState(Boolean(instrumentSeed) || Boolean(initial))
  const [loading, setLoading] = useState(!initial)
  const [text, setText] = useState('')
  const [type, setType] = useState<SoundQuery['type']>(lockType && lockType !== 'all' ? lockType : 'all')
  useEffect(() => {
    setType(lockType && lockType !== 'all' ? lockType : 'all')
  }, [lockType])
  const [bpm, setBpm] = useState<SoundQuery['bpm']>('any')
  const [key, setKey] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
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
    void loadSoundCatalog(fetch, soundCache()).then((next) => {
      if (!alive) return
      setResult(next)
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
      setStartersReady(true)
    }).catch(() => {
      if (alive) setStartersReady(true)
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
      if (target?.closest('.sound-panel, .sound-slot, .playlist-browser')) return
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
    bpm,
    key,
    favoritesOnly,
    projectBpm: sounds.tempo,
    favorites: sounds.favorites,
  }
  const filtered = type === 'instrument' ? [] : filterSounds(result.entries, query)
  const starterRows = filterStarters(starters, query)
  const shownSounds = filtered.slice(0, LIST_CAP)
  const shown = shownSounds.length + starterRows.length
  const total = filtered.length + starterRows.length
  const keys = soundKeys(result.entries)
  const queryActive = Boolean(text || type !== 'all' || bpm !== 'any' || key || favoritesOnly)
  const waiting = loading || (!startersReady && type !== 'one-shot' && type !== 'loop' && type !== 'drum')
  const message = waiting
    ? 'Loading sounds…'
    : total
      ? ''
      : catalogMessage(result, 0, queryActive || type === 'instrument')
  const soundWhere = sounds.trackName ? `Adds to ${sounds.trackName} at the playhead.` : 'Add an audio track to place sounds.'
  const instrumentWhere = sounds.instrumentName ? `Loads onto ${sounds.instrumentName}.` : 'Add an instrument track to load a sound.'
  const where = type === 'instrument'
    ? instrumentWhere
    : starterRows.length
      ? `${soundWhere} ${instrumentWhere}`
      : soundWhere
  const count = matchCountLabel(total, shown)
  const slot = focusedSlot(store)

  async function reload() {
    setLoading(true)
    const [next, list] = await Promise.all([
      loadSoundCatalog(fetch, soundCache()),
      refreshStarterCatalog().catch(() => starters),
    ])
    setResult(next)
    setStarters(list)
    setLoading(false)
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
    const dropped = trackId ? store.track(trackId) : null
    const target = dropped?.type === 'midi' ? dropped.id : sounds.instrumentId
    if (!target) {
      store.toast('Add an instrument track first.', 'warn')
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
    const target = audioTrackFor(store.project, sounds.trackId, trackId)
    if (!target) {
      store.toast('Add an audio track first.', 'warn')
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
    const target = dropped?.type === 'midi' ? dropped.id : sounds.instrumentId
    if (!target) {
      store.toast('Add an instrument track first.', 'warn')
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

  const panel = (
    <div className="sound-panel" id="sound-browser" role="complementary" aria-label="Sounds. Loops, one-shots, and instruments from the free library.">
      <div className="sound-head">
        <div>
          <h2>Sounds</h2>
          <p>{phone ? 'Tap Add to put a sound on the selected track.' : 'Drag a sound onto a track, or into the sampler or looper. It lands at the playhead.'}</p>
        </div>
        <TipButton label="Close" hint="Close the sound browser." onClick={onClose} />
      </div>
      <div className="sound-filters">
        <input
          aria-label="Search sounds. Matches names and tags."
          title="Matches names and tags."
          placeholder="Search tags"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {!lockType && (
          <select aria-label="Kind. One-shots, loops, drums, or instruments." title="One-shots, loops, drums, or instruments." value={type} onChange={(event) => setType(event.target.value as SoundQuery['type'])}>
            <option value="all">All kinds</option>
            <option value="one-shot">One-shots</option>
            <option value="loop">Loops</option>
            <option value="drum">Drums</option>
            <option value="instrument">Instruments</option>
          </select>
        )}
        {type !== 'instrument' && (
          <>
            <select aria-label="Tempo. Loops near the song tempo, including half-time and double-time." title="Loops near the song tempo, including half-time and double-time." value={bpm} onChange={(event) => setBpm(event.target.value as SoundQuery['bpm'])}>
              <option value="any">Any tempo</option>
              <option value="project">Song tempo</option>
            </select>
            <select aria-label="Key. Only sounds in this key." title="Only sounds in this key." value={key} onChange={(event) => setKey(event.target.value)}>
              <option value="">Any key</option>
              {keys.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </>
        )}
        <TipButton
          label="Favorites"
          hint="Only sounds saved in this project."
          pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((value) => !value)}
        />
      </div>
      <p className="sound-where">{where}</p>
      {message && (
        <p className="sound-status">
          {message}
          {result.status === 'missing' && !waiting && starterRows.length === 0 && (
            <>
              {' '}
              <button type="button" title="Check the sound library again." aria-label="Try again. Check the sound library again." onClick={() => void reload()}>Try again</button>
            </>
          )}
        </p>
      )}
      <div className="sound-list">
        {starterRows.map((entry) => {
          const saved = sounds.favorites.includes(entry.id)
          const loaded = store.track(sounds.instrumentId ?? '')?.library?.id === entry.id
          return (
            <div className="sound-row" key={entry.id}>
              <div
                className="sound-copy"
                draggable={!phone}
                title={phone ? entry.description : `Drag onto an instrument track. ${entry.description}`}
                onDragStart={(event) => {
                  dragId = `${INSTRUMENT_PREFIX}${entry.id}`
                  event.dataTransfer.setData(SOUND_MIME, dragId)
                  event.dataTransfer.setData('text/plain', entry.name)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onDragEnd={() => { dragId = '' }}
              >
                <strong>{entry.name}</strong>
                <span className="sound-meta">Instrument{entry.category ? ` · ${entry.category}` : ''}</span>
                <span className="sound-info" title={`${entry.description} Audio streams from Hugging Face.`}>{entry.license} · Hugging Face</span>
              </div>
              <div className="sound-actions">
                <TipButton
                  label={loaded ? 'Play' : 'Load'}
                  hint={loaded ? 'Play this instrument on the speakers.' : 'Load it on this track and play a note.'}
                  disabled={busy === entry.id || !sounds.instrumentId}
                  onClick={() => { engine.unlock(); void loadInstrument(entry, null, true) }}
                />
                <TipButton
                  label={saved ? 'Saved' : 'Save'}
                  hint="Keep this sound in the project favorites."
                  pressed={saved}
                  disabled={store.remoteFollow}
                  onClick={() => store.toggleSoundFavorite(entry.id)}
                />
              </div>
            </div>
          )
        })}
        {shownSounds.map((entry) => {
          const saved = sounds.favorites.includes(entry.id)
          const playLabel = playing === entry.id ? 'Stop' : 'Play'
          const playHint = entry.type === 'loop'
            ? 'Play on the speakers at the song tempo.'
            : 'Play this sound on the speakers.'
          return (
            <div className="sound-row" key={entry.id}>
              <div
                className="sound-copy"
                draggable={!phone}
                title={phone ? undefined : 'Drag onto a track, or into the sampler or looper.'}
                onDragStart={(event) => {
                  dragId = entry.id
                  event.dataTransfer.setData(SOUND_MIME, entry.id)
                  event.dataTransfer.setData('text/plain', entry.name)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onDragEnd={() => { dragId = '' }}
              >
                <strong>{entry.name}</strong>
                <span className="sound-meta">
                  {KIND_LABEL[entry.type]}
                  {entry.bpm ? ` · ${Math.round(entry.bpm)} bpm` : ''}
                  {entry.key ? ` · ${entry.key}` : ''}
                </span>
                <span className="sound-info" title="Credit for this recording. The audio file plays from Hugging Face.">{entry.license} · {entry.source || 'Source not listed'}</span>
              </div>
              <div className="sound-actions">
                <TipButton label={playLabel} hint={playHint} disabled={busy === entry.id} onClick={() => { engine.unlock(); void preview(entry) }} />
                <TipButton label="Add" hint="Put this sound on the selected track at the playhead." disabled={busy === entry.id || !sounds.trackId} onClick={() => { engine.unlock(); void add(entry) }} />
                <TipButton label="Keys" hint="Play as instrument. Pitch this sound across the keyboard." disabled={busy === entry.id || !sounds.instrumentId} onClick={() => { engine.unlock(); void playAsInstrument(entry) }} />
                {slot && <TipButton label="Slot" hint="Put this sound in the open sampler or looper." disabled={busy === entry.id} onClick={() => { engine.unlock(); void intoSlot(entry) }} />}
                <TipButton
                  label={saved ? 'Saved' : 'Save'}
                  hint="Keep this sound in the project favorites."
                  pressed={saved}
                  disabled={store.remoteFollow}
                  onClick={() => store.toggleSoundFavorite(entry.id)}
                />
              </div>
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
