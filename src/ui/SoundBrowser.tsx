import { useMemo, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { downloadParts, oldestId, planStore, storageBudget, touchLru } from '../model/libraryHost'
import { NOTE_NAMES } from '../model/scale'
import { deleteLibraryFile, writeLibraryFile } from '../storage/libraryFiles'
import type { FormFactor } from './form'
import {
  addToCollection,
  buildIndex,
  catalog,
  emptyQuery,
  fitBuffer,
  fitPreview,
  groupValues,
  noteUse,
  previewRate,
  searchSounds,
  tagCounts,
  toggleFavorite,
  withUserTag,
  withoutUserTag,
  type SoundEntry,
  type SoundSort,
  type TagGroup,
} from '../model/sounds'
import type { ProjectStore } from '../state/store'

const BANDS = [
  { id: 'slow', label: '80–100', min: 80, max: 100 },
  { id: 'mid', label: '100–130', min: 100, max: 130 },
  { id: 'fast', label: '130–160', min: 130, max: 160 },
]

export function SoundBrowser({
  store,
  engine,
  layout,
  form,
  onClose,
  onPlace,
}: {
  store: ProjectStore
  engine: AudioEngine
  layout: 'sheet' | 'pane'
  form: FormFactor
  onClose: () => void
  onPlace: (id: string, trackId: string | null, startSample: number) => void
}) {
  const personal = store.soundState()
  const projectKey = NOTE_NAMES[store.scaleState().root]
  const [text, setText] = useState('')
  const [sort, setSort] = useState<SoundSort>('relevance')
  const [groups, setGroups] = useState<Partial<Record<TagGroup, string[]>>>({})
  const [band, setBand] = useState<string | null>(null)
  const [matchProject, setMatchProject] = useState(false)
  const [starred, setStarred] = useState(false)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const entries = useMemo(() => catalog().concat(personal.imports), [personal.imports])
  const index = useMemo(() => buildIndex(entries), [entries])
  const chosen = BANDS.find((item) => item.id === band)
  const query = {
    ...emptyQuery(store.project.tempo, projectKey),
    text,
    sort,
    groups,
    bpmMin: matchProject ? null : chosen?.min ?? null,
    bpmMax: matchProject ? null : chosen?.max ?? null,
    matchProject,
    favoritesOnly: starred,
    collectionId,
  }
  const results = searchSounds(index, query, personal)
  const counts = tagCounts(index, query, personal)
  const chips = chipList(entries, personal, counts, groups)
  const stored = libraryBytes(entries, personal)
  const budget = storageBudget(form)

  function toggle(group: TagGroup, value: string) {
    const current = groups[group] ?? []
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    setGroups({ ...groups, [group]: next })
  }

  function play(item: SoundEntry) {
    engine.unlock()
    const asset = item.bufferId ? store.buffers.get(item.bufferId) : undefined
    if (asset?.channels[0]) {
      const rate = item.type === 'loop' ? previewRate(item.bpm, item.key, store.project.tempo, projectKey) : 1
      engine.previewSound(fitBuffer(asset.channels[0], rate))
      return
    }
    engine.previewSound(fitPreview(item, store.project.sampleRate, store.project.tempo, projectKey))
  }

  return (
    <div className={`sound-browser ${layout}`} role="dialog" aria-label="Sounds" data-sound="open">
      <div className="sound-search">
        <input aria-label="Search" value={text} onChange={(event) => setText(event.target.value)} />
        <select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as SoundSort)}>
          <option value="relevance">Relevance</option>
          <option value="name">Name</option>
          <option value="newest">Newest</option>
          <option value="used">Used</option>
        </select>
        <span className="sound-used">{mb(stored) || '0'} / {mb(budget)}</span>
        {personal.cached.length > 0 && <button type="button" aria-label="Free" onClick={() => freeOldest(store)}>Free</button>}
        <button type="button" className="text-btn" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="sound-chips">
        {chips.filter((chip) => (groups[chip.group] ?? []).includes(chip.value)).map((chip) => (
          <button key={`on-${chip.group}-${chip.value}`} type="button" className="chip on" onClick={() => toggle(chip.group, chip.value)}>
            {chip.value} {counts.get(`${chip.group}:${chip.value}`) ?? 0} ×
          </button>
        ))}
        {band && <button type="button" className="chip on" onClick={() => setBand(null)}>{BANDS.find((item) => item.id === band)?.label} ×</button>}
        {matchProject && <button type="button" className="chip on" onClick={() => setMatchProject(false)}>Project ×</button>}
        {starred && <button type="button" className="chip on" onClick={() => setStarred(false)}>Starred ×</button>}
        {chips.filter((chip) => !(groups[chip.group] ?? []).includes(chip.value)).map((chip) => (
          <button key={`${chip.group}-${chip.value}`} type="button" className="chip" onClick={() => toggle(chip.group, chip.value)}>
            {chip.value} {counts.get(`${chip.group}:${chip.value}`) ?? 0}
          </button>
        ))}
        {BANDS.map((item) => item.id === band ? null : (
          <button key={item.id} type="button" className="chip" onClick={() => { setBand(item.id); setMatchProject(false) }}>{item.label}</button>
        ))}
        {!matchProject && <button type="button" className="chip" onClick={() => { setMatchProject(true); setBand(null) }}>Project</button>}
        {!starred && <button type="button" className="chip" onClick={() => setStarred(true)}>Starred</button>}
        {personal.collections.map((collection) => (
          <button key={collection.id} type="button" className={collectionId === collection.id ? 'chip on' : 'chip'} onClick={() => setCollectionId(collectionId === collection.id ? null : collection.id)}>
            {collection.name}
          </button>
        ))}
      </div>
      <div className="sound-list">
        {results.map((item) => {
          const ready = available(item, personal)
          return (
            <div key={item.id} className={picked === item.id ? 'sound-row picked' : 'sound-row'}>
              <button
                type="button"
                className="sound-name"
                draggable
                onDragStart={(event) => event.dataTransfer.setData('application/x-cueharbor-sound', item.id)}
                onClick={() => { setPicked(item.id); play(item) }}
              >
                <b>{item.name}</b>
                <i>{ready ? mb(item.bytes) || item.type : `Get ${mb(item.bytes)}`}</i>
              </button>
              <button type="button" aria-label={personal.favorite.includes(item.id) ? `Unstar ${item.name}` : `Star ${item.name}`} className={personal.favorite.includes(item.id) ? 'on' : ''} onClick={() => store.setSounds(toggleFavorite(personal, item.id))}>★</button>
              <button type="button" aria-label={`Add ${item.name}`} onClick={() => onPlace(item.id, null, engine.positionSamples)}>Add</button>
              {(item.origin === 'import' || personal.cached.includes(item.id)) && (
                <button type="button" aria-label={`Remove ${item.name}`} onClick={() => store.setSounds({
                  ...personal,
                  cached: personal.cached.filter((id) => id !== item.id),
                  imports: personal.imports.filter((row) => row.id !== item.id),
                })}>×</button>
              )}
              {picked === item.id && (
                <input
                  aria-label={`Tag ${item.name}`}
                  placeholder="Tag"
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    const value = event.currentTarget.value
                    store.setSounds(withUserTag(personal, item.id, value))
                    event.currentTarget.value = ''
                  }}
                />
              )}
              {(personal.userTags[item.id] ?? []).map((tag) => (
                <button key={tag} type="button" className="chip on" onClick={() => store.setSounds(withoutUserTag(personal, item.id, tag))}>{tag} ×</button>
              ))}
              <button type="button" aria-label={`Save ${item.name}`} onClick={() => {
                const existing = personal.collections[0] ?? { id: 'mine', name: 'Mine', ids: [] }
                const collections = personal.collections.length ? personal.collections : [existing]
                store.setSounds(addToCollection({ ...personal, collections }, existing.id, item.id))
              }}>Save</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export async function placeSound(store: ProjectStore, id: string, trackId: string | null, startSample: number, form: FormFactor) {
  const personal = store.soundState()
  const rows = catalog().concat(personal.imports)
  const item = rows.find((entry) => entry.id === id)
  if (!item) return
  const incoming = available(item, personal) ? 0 : item.bytes
  const decision = planStore(libraryBytes(rows, personal), incoming, storageBudget(form))
  if (decision === 'block') {
    store.toast('Storage full', 'warn')
    return
  }
  if (decision === 'warn') store.toast('Storage low', 'warn')
  if (incoming > 0 && item.urls?.length) {
    try {
      await writeLibraryFile(item.id, await downloadParts(item.urls, fetch))
    } catch {
      store.toast('Download failed', 'warn')
      return
    }
  }
  const loom = store.project.loom
  if (loom && (item.type === 'instrument' || item.type === 'preset')) {
    const instrument = loom.instruments.find((entry) => entry.id === item.id)
    const patch = loom.patches.find((entry) => entry.id === item.id)
    if (instrument || patch) store.setLoom({ ...loom, active: instrument?.id ?? loom.active, patchId: patch?.id ?? loom.patchId })
  }
  const audioTrack = store.project.tracks.find((track) => track.id === (trackId ?? store.selectedTrackId) && track.type === 'audio')
    ?? store.project.tracks.find((track) => track.type === 'audio')
  const drop = trackId != null || (item.type !== 'instrument' && item.type !== 'preset')
  if (audioTrack && drop) {
    const key = NOTE_NAMES[store.scaleState().root]
    const asset = item.bufferId ? store.buffers.get(item.bufferId) : undefined
    const rate = asset && item.type === 'loop' ? previewRate(item.bpm, item.key, store.project.tempo, key) : 1
    const audio = asset?.channels[0] ? fitBuffer(asset.channels[0], rate) : fitPreview(item, store.project.sampleRate, store.project.tempo, key)
    const bufferId = `snd_${item.id}_${Math.round(startSample)}`
    store.addAsset({ id: bufferId, name: item.name, sampleRate: store.project.sampleRate, channels: [audio] })
    store.addAudioClip(audioTrack.id, {
      id: `clip_${bufferId}`,
      name: item.name,
      bufferId,
      startSample: Math.max(0, Math.round(startSample)),
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: item.origin === 'import' ? 'import' : 'local',
    })
  }
  const cached = item.bytes > 0 && !personal.cached.includes(item.id) ? [...personal.cached, item.id] : personal.cached
  if (incoming > 0 && !item.urls?.length) {
    const key = NOTE_NAMES[store.scaleState().root]
    const rendered = fitPreview(item, store.project.sampleRate, store.project.tempo, key)
    const bytes = new Uint8Array(rendered.byteLength)
    bytes.set(new Uint8Array(rendered.buffer.slice(rendered.byteOffset, rendered.byteOffset + rendered.byteLength)))
    await writeLibraryFile(item.id, bytes)
  }
  rememberLru(item.id)
  store.setSounds(noteUse({ ...personal, cached }, item.id))
}

export function freeOldest(store: ProjectStore) {
  const personal = store.soundState()
  const id = oldestId(readLru(), personal.cached)
  if (!id) return
  void deleteLibraryFile(id)
  const next = readLru()
  delete next[id]
  writeLru(next)
  store.setSounds({ ...personal, cached: personal.cached.filter((item) => item !== id) })
}

const LRU_KEY = 'cueharbor-library-lru'

function readLru() {
  try {
    return JSON.parse(localStorage.getItem(LRU_KEY) || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function writeLru(map: Record<string, number>) {
  try {
    localStorage.setItem(LRU_KEY, JSON.stringify(map))
  } catch {
    /* the file is still removed from the project list */
  }
}

function rememberLru(id: string) {
  writeLru(touchLru(readLru(), id, Date.now()))
}

function libraryBytes(entries: SoundEntry[], personal: ReturnType<ProjectStore['soundState']>) {
  return entries.reduce((sum, item) => sum + (item.origin !== 'import' && item.origin !== 'synth' && personal.cached.includes(item.id) ? item.bytes : 0), 0)
}

function available(item: SoundEntry, personal: ReturnType<ProjectStore['soundState']>) {
  return item.origin === 'synth' || item.origin === 'import' || personal.cached.includes(item.id)
}

function chipList(entries: SoundEntry[], personal: ReturnType<ProjectStore['soundState']>, counts: Map<string, number>, groups: Partial<Record<TagGroup, string[]>>) {
  const order: TagGroup[] = ['type', 'category', 'genre', 'character', 'key', 'pack']
  const seen = new Set<string>()
  const chips: { group: TagGroup; value: string }[] = []
  for (const group of order) {
    for (const item of entries) {
      for (const value of groupValues(item, personal, group)) {
        const key = `${group}:${value}`
        if (seen.has(key)) continue
        seen.add(key)
        if ((counts.get(key) ?? 0) > 0 || (groups[group] ?? []).includes(value)) chips.push({ group, value })
      }
    }
  }
  return chips
}

function mb(bytes: number) {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) {
    const value = bytes / (1024 * 1024)
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
