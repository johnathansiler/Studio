import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { catalogMessage, filterSounds, loadSoundCatalog, soundKeys } from '../sounds/catalog'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor, trackIdFromDrop } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import { decodeSlotFile, focusedSlot, SOUND_MIME } from '../audio/sample/slot'
import type { CatalogResult, SoundEntry, SoundKind, SoundQuery } from '../sounds/types'
import { uid } from '../model/types'
import { selectSounds } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'
import './sound-browser.css'

let dragId = ''

const KIND_LABEL: Record<SoundKind, string> = {
  'one-shot': 'One-shot',
  loop: 'Loop',
  instrument: 'Instrument',
}

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
}

export function SoundBrowser({
  store,
  engine,
  phone,
  onClose,
  initial,
}: {
  store: ProjectStore
  engine: PreviewEngine
  phone: boolean
  onClose: () => void
  /** Tests pass a catalog so the panel can render without the network. */
  initial?: CatalogResult
}) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const sounds = selectSounds(store)
  const [result, setResult] = useState<CatalogResult>(initial ?? { entries: [], status: 'missing' })
  const [loading, setLoading] = useState(!initial)
  const [text, setText] = useState('')
  const [type, setType] = useState<SoundQuery['type']>('all')
  const [bpm, setBpm] = useState<SoundQuery['bpm']>('any')
  const [key, setKey] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [busy, setBusy] = useState('')
  const [playing, setPlaying] = useState('')
  const entriesRef = useRef(result.entries)
  const addRef = useRef<(entry: SoundEntry, trackId?: string | null) => void>(() => undefined)
  const slotRef = useRef<(entry: SoundEntry) => void>(() => undefined)
  entriesRef.current = result.entries

  useEffect(() => {
    if (initial) return
    let alive = true
    void loadSoundCatalog(fetch, soundCache()).then((next) => {
      if (!alive) return
      setResult(next)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [initial])

  useEffect(() => () => engine.stopPreview(), [engine])

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
      if (target?.closest('.sound-panel')) return
      event.preventDefault()
      const entryForSlot = entriesRef.current.find((item) => item.id === id)
      if (target?.closest('[data-slot-drop]') && entryForSlot) {
        dragId = ''
        slotRef.current(entryForSlot)
        return
      }
      const entry = entriesRef.current.find((item) => item.id === id)
      dragId = ''
      if (entry) addRef.current(entry, trackIdFromDrop(target))
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
  const filtered = filterSounds(result.entries, query)
  const shown = filtered.slice(0, 200)
  const keys = soundKeys(result.entries)
  const message = loading ? 'Loading sounds…' : catalogMessage(result, filtered.length, Boolean(text || type !== 'all' || bpm !== 'any' || key || favoritesOnly))
  const where = sounds.trackName
    ? `Adds to ${sounds.trackName} at the playhead.`
    : 'Add an audio track to place sounds.'

  async function reload() {
    setLoading(true)
    const next = await loadSoundCatalog(fetch, soundCache())
    setResult(next)
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

  async function add(entry: SoundEntry, trackId?: string | null) {
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
        startSample: engine.currentTimelineSample(),
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
  addRef.current = (entry, trackId) => {
    engine.unlock()
    void add(entry, trackId)
  }

  async function intoSlot(entry: SoundEntry) {
    const slot = focusedSlot(store)
    if (!slot) {
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
      store.loadSlotAudio(slot.trackId, slot.pluginId, {
        id: uid('smp'),
        name: entry.name,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      })
      store.toast(`${entry.name} is in the ${slot.kind}.`, 'good')
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

  return (
    <div className={`sound-back ${phone ? 'sheet' : 'dock'}`} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="sound-panel" id="sound-browser" role="dialog" aria-label="Sounds. Loops, one-shots, and instruments from the free library.">
        <div className="sound-head">
          <div>
            <h2>Sounds</h2>
            <p>{phone ? 'Tap Add to put a sound on the selected track at the playhead.' : 'Drag a sound onto a track, or tap Add. It lands at the playhead.'}</p>
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
          <select aria-label="Kind. One-shots, loops, or instruments." title="One-shots, loops, or instruments." value={type} onChange={(event) => setType(event.target.value as SoundQuery['type'])}>
            <option value="all">All kinds</option>
            <option value="one-shot">One-shots</option>
            <option value="loop">Loops</option>
            <option value="instrument">Instruments</option>
          </select>
          <select aria-label="Tempo. Loops near the song tempo, including half-time and double-time." title="Loops near the song tempo, including half-time and double-time." value={bpm} onChange={(event) => setBpm(event.target.value as SoundQuery['bpm'])}>
            <option value="any">Any tempo</option>
            <option value="project">Song tempo</option>
          </select>
          <select aria-label="Key. Only sounds in this key." title="Only sounds in this key." value={key} onChange={(event) => setKey(event.target.value)}>
            <option value="">Any key</option>
            {keys.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
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
            {result.status === 'missing' && !loading && (
              <>
                {' '}
                <button type="button" title="Check the sound library again." aria-label="Try again. Check the sound library again." onClick={() => void reload()}>Try again</button>
              </>
            )}
          </p>
        )}
        <div className="sound-list">
          {shown.map((entry) => {
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
                  <span className="sound-info">{entry.license} · {entry.source || 'Source not listed'}</span>
                </div>
                <div className="sound-actions">
                  <TipButton label={playLabel} hint={playHint} disabled={busy === entry.id} onClick={() => { engine.unlock(); void preview(entry) }} />
                  <TipButton label="Add" hint="Put this sound on the selected track at the playhead." disabled={busy === entry.id || !sounds.trackId} onClick={() => { engine.unlock(); void add(entry) }} />
                  {focusedSlot(store) && <TipButton label="Slot" hint="Put this sound in the open sampler or looper." disabled={busy === entry.id} onClick={() => { engine.unlock(); void intoSlot(entry) }} />}
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
        {filtered.length > shown.length && <p className="sound-status">Showing the first 200. Narrow the search to see more.</p>}
      </div>
    </div>
  )
}
