import { useEffect, useMemo, useState, type RefObject } from 'react'
import { loadPerformanceLibrary, packCatalog, styleCatalog } from '../instruments/scaler/perform'
import { activeScaleId, normalizeScaler, padPerformance } from '../instruments/scaler/model'
import type { ScalerNote, ScalerState } from '../instruments/scaler/types'
import { freshSeed, rememberTake, type PlayStyle } from '../instruments/scaler/vary'
import type { GenrePack } from '../instruments/scaler/catalog/library'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'

type Row = {
  id: string
  name: string
  kind: 'Style' | 'Pack'
  genre: string
  mood: string
  culture: string
  category: string
  description: string
  performanceId: string
  voicing?: ScalerState['voicing']
  rate?: number
  swing?: number
}

const AMOUNTS = [
  { id: 'subtle', label: 'Subtle' },
  { id: 'medium', label: 'Medium' },
  { id: 'major', label: 'Major' },
] as const

const EVOLVE = [
  { id: 'off', label: 'Off' },
  { id: 'bar', label: 'Each bar' },
  { id: 'loop', label: 'Each loop' },
] as const

export function ScalerPerformances({
  open,
  onClose,
  triggerRef,
  store,
  trackId,
  state,
  pad,
  bar,
  onHear,
}: {
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
  store: ProjectStore
  trackId: string
  state: ScalerState
  pad: number
  bar: number
  onHear: (notes: ScalerNote[]) => void
}) {
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [style, setStyle] = useState('all')
  const [genre, setGenre] = useState('all')
  const [mood, setMood] = useState('all')
  const [culture, setCulture] = useState('all')
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  useEffect(() => {
    let alive = true
    void loadPerformanceLibrary().then(() => { if (alive) setTick((value) => value + 1) })
    return () => { alive = false }
  }, [])

  const rows = useMemo(() => browseRows(), [tick])
  const styles = uniq(rows.map((row) => row.category))
  const genres = uniq(rows.map((row) => row.genre))
  const moods = uniq(rows.map((row) => row.mood))
  const cultures = uniq(rows.map((row) => row.culture))
  const text = query.trim().toLowerCase()
  const shown = rows.filter((row) => {
    if (style !== 'all' && row.category !== style) return false
    if (genre !== 'all' && row.genre !== genre) return false
    if (mood !== 'all' && row.mood !== mood) return false
    if (culture !== 'all' && row.culture !== culture) return false
    if (favoritesOnly && !state.favorites.includes(row.id)) return false
    if (!text) return true
    return `${row.name} ${row.description} ${row.genre} ${row.mood} ${row.culture} ${row.category}`.toLowerCase().includes(text)
  })
  const takes = state.variationTakes
  const takeLabel = takes.length ? `Take ${state.variationTake + 1} of ${takes.length}` : 'No takes yet'

  function current() {
    return normalizeScaler(store.track(trackId)?.scaler)
  }

  function preview(next = current()) {
    const chords = Math.max(1, pad + 1)
    const played = padPerformance(next, Math.min(pad, chords - 1), bar)
    if (played?.notes.length) onHear(played.notes)
  }

  function applyRow(row: Row) {
    const now = current()
    const seed = now.variationLock ? now.variationSeed : freshSeed(now.variationSeed)
    const memory = now.variationLock
      ? { takes: now.variationTakes, index: now.variationTake, seed }
      : rememberTake(now.variationTakes, now.variationTake, seed)
    store.setScaler(trackId, {
      performanceId: row.performanceId,
      variationSeed: memory.seed,
      variationTakes: memory.takes,
      variationTake: memory.index,
      ...(row.rate != null ? { rate: row.rate } : {}),
      ...(row.swing != null ? { swing: row.swing } : {}),
      ...(row.voicing ? { voicing: row.voicing } : {}),
    })
    preview()
  }

  function audition(row: Row) {
    const now = current()
    const played = padPerformance(normalizeScaler({
      ...now,
      performanceId: row.performanceId,
      ...(row.rate != null ? { rate: row.rate } : {}),
      ...(row.swing != null ? { swing: row.swing } : {}),
      ...(row.voicing ? { voicing: row.voicing } : {}),
    }), pad, bar)
    if (played?.notes.length) onHear(played.notes)
  }

  function regenerate() {
    const now = current()
    const seed = freshSeed(now.variationSeed)
    const memory = rememberTake(now.variationTakes, now.variationTake, seed)
    store.setScaler(trackId, { variationSeed: memory.seed, variationTakes: memory.takes, variationTake: memory.index })
    preview()
  }

  function stepTake(dir: number) {
    const now = current()
    if (!now.variationTakes.length) return
    const index = Math.min(now.variationTakes.length - 1, Math.max(0, now.variationTake + dir))
    store.setScaler(trackId, { variationTake: index, variationSeed: now.variationTakes[index] })
    preview()
  }

  function toggleFavorite(id: string) {
    const now = current()
    const has = now.favorites.includes(id)
    store.setScaler(trackId, { favorites: has ? now.favorites.filter((item) => item !== id) : [...now.favorites, id].slice(0, 64) })
  }

  function toggleMidi(id: string) {
    const now = current()
    const has = now.midiTo.includes(id)
    store.setScaler(trackId, { midiTo: has ? now.midiTo.filter((item) => item !== id) : [...now.midiTo, id].slice(0, 8) })
  }

  const others = store.project.tracks.filter((track) => track.type === 'midi' && track.id !== trackId)
  const active = styleCatalog().find((item) => item.id === state.performanceId) ?? packCatalog().find((item) => item.id === state.performanceId)

  return (
    <AnchoredMenu open={open} onClose={onClose} label="Performances" triggerRef={triggerRef} prefer="down" className="perf-menu">
      <p className="perf-note">{active ? active.name : 'Block chord'}. {activeScaleId(state)}. {takeLabel}.</p>
      <input aria-label="Search performances" placeholder="Search performances" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="perf-filters">
        <Filter label="Style" value={style} options={styles} onChange={setStyle} />
        <Filter label="Genre" value={genre} options={genres} onChange={setGenre} />
        <Filter label="Mood" value={mood} options={moods} onChange={setMood} />
        <Filter label="Culture" value={culture} options={cultures} onChange={setCulture} />
        <button type="button" className={favoritesOnly ? 'on' : ''} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}>Favorites</button>
      </div>
      <div className="perf-variation" role="group" aria-label="Variation">
        {AMOUNTS.map((amount) => (
          <button key={amount.id} type="button" className={state.variation === amount.id ? 'on' : ''} aria-pressed={state.variation === amount.id} onClick={() => { store.setScaler(trackId, { variation: amount.id }); preview() }}>
            {amount.label}
          </button>
        ))}
        <button type="button" onClick={regenerate} title="Make a new take from a new seed.">Regenerate</button>
        <button type="button" className={state.variationLock ? 'on' : ''} aria-pressed={state.variationLock} title="Keep this seed. Apply will not mint a new one." onClick={() => store.setScaler(trackId, { variationLock: !state.variationLock })}>
          Lock seed
        </button>
        <button type="button" onClick={() => stepTake(-1)} title={takeLabel}>Previous take</button>
        <button type="button" onClick={() => stepTake(1)} title={takeLabel}>Next take</button>
        {EVOLVE.map((mode) => (
          <button key={mode.id} type="button" className={state.evolve === mode.id ? 'on' : ''} aria-pressed={state.evolve === mode.id} onClick={() => { store.setScaler(trackId, { evolve: mode.id }); preview() }}>
            {mode.id === 'off' ? 'Evolve off' : mode.label}
          </button>
        ))}
      </div>
      <div className="perf-route" role="group" aria-label="MIDI routing">
        <button type="button" className={state.recordSource === 'input' ? 'on' : ''} aria-pressed={state.recordSource === 'input'} onClick={() => store.setScaler(trackId, { recordSource: 'input' })}>Record input</button>
        <button type="button" className={state.recordSource === 'output' ? 'on' : ''} aria-pressed={state.recordSource === 'output'} onClick={() => store.setScaler(trackId, { recordSource: 'output' })}>Record output</button>
        <button type="button" className={state.thru ? 'on' : ''} aria-pressed={state.thru} title="Also send the note that came in." onClick={() => store.setScaler(trackId, { thru: !state.thru })}>Thru</button>
        <span className="perf-note">MIDI to</span>
        {others.map((track) => (
          <button key={track.id} type="button" className={state.midiTo.includes(track.id) ? 'on' : ''} aria-pressed={state.midiTo.includes(track.id)} onClick={() => toggleMidi(track.id)}>{track.name}</button>
        ))}
        {!others.length && <span className="perf-note">Add another MIDI track to send Scaler there.</span>}
      </div>
      <div className="perf-list" role="list" aria-label="Performance list">
        {!rows.length && <p className="perf-note">Performances are loading.</p>}
        {rows.length > 0 && !shown.length && <p className="perf-note">No performances match.</p>}
        {shown.slice(0, 24).map((row) => (
          <div key={row.id} className="perf-row" role="listitem">
            <strong title={row.description}>{row.name}</strong>
            <span>{row.kind}</span>
            <button type="button" className={state.favorites.includes(row.id) ? 'on' : ''} aria-pressed={state.favorites.includes(row.id)} onClick={() => toggleFavorite(row.id)}>
              {state.favorites.includes(row.id) ? 'Favorite' : 'Mark favorite'}
            </button>
            <button type="button" onClick={() => audition(row)}>Audition</button>
            <button type="button" onClick={() => applyRow(row)}>Apply</button>
          </div>
        ))}
      </div>
    </AnchoredMenu>
  )
}

function Filter({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="perf-filter">
      {label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="all">All</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

function browseRows(): Row[] {
  const styles = styleCatalog().map(styleRow)
  const packs = packCatalog().map(packRow)
  return [...packs, ...styles]
}

function styleRow(style: PlayStyle): Row {
  return {
    id: style.id,
    name: style.name,
    kind: 'Style',
    genre: style.genre,
    mood: style.mood,
    culture: style.culture,
    category: style.category,
    description: style.description,
    performanceId: style.id,
    rate: style.rate,
    swing: style.swing,
    voicing: style.voicing && style.voicing !== 'extended' ? style.voicing : undefined,
  }
}

function packRow(pack: GenrePack): Row {
  return {
    id: pack.id,
    name: pack.name,
    kind: 'Pack',
    genre: pack.genre,
    mood: pack.mood,
    culture: pack.culture,
    category: 'Pack',
    description: pack.description,
    performanceId: pack.performanceId,
    voicing: pack.voicing,
  }
}

function uniq(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}
