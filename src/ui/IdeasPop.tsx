import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { NOTE_NAMES } from '../model/scale'
import {
  GENRES,
  MOODS,
  chordNames,
  filterIdeas,
  progressionById,
  randomIdea,
  romanLine,
  spellProgression,
  voiceLead,
  type Progression,
} from '../model/progressions'
import type { ProjectStore } from '../state/store'

export function IdeasPop({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const scale = store.scaleState()
  const [query, setQuery] = useState('')
  const [genre, setGenre] = useState('all')
  const [mood, setMood] = useState('all')
  const [selected, setSelected] = useState(scale.idea || 'axis')
  const [open, setOpen] = useState(scale.idea || 'axis')
  const timers = useRef<number[]>([])
  const list = filterIdeas(query, genre, mood)
  const current = progressionById(selected) ?? list[0] ?? null
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer)
  }, [])
  const hear = (item: Progression, chords = item.chords) => {
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
    engine.unlock()
    const spelled = voiceLead(spellProgression(chords, item.mode, scale.root))
    const beatMs = 60000 / Math.max(40, item.tempo)
    spelled.forEach((chord, index) => {
      const timer = window.setTimeout(() => engine.previewPitches(chord.pitches), index === 0 ? 0 : chord.startBeat * beatMs)
      timers.current.push(timer)
    })
  }
  return (
    <div className="ideas-pop" data-ideas="open" role="dialog" aria-label="Ideas">
      <header>
        <strong>Ideas</strong>
        <input aria-label="Search ideas" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" onClick={() => {
          const pick = randomIdea(filterIdeas('', genre, 'all'))
          if (!pick) return
          setSelected(pick.id)
          setOpen(pick.id)
          setQuery('')
          setMood('all')
        }}>Random</button>
        <button type="button" className="text-btn" onClick={onClose} aria-label="Close ideas">×</button>
      </header>
      <div className="chip-row" aria-label="Genre">
        <button type="button" className={genre === 'all' ? 'on' : ''} onClick={() => setGenre('all')}>All</button>
        {GENRES.map((item) => (
          <button key={item} type="button" className={genre === item ? 'on' : ''} onClick={() => setGenre(item)}>{item}</button>
        ))}
      </div>
      <div className="chip-row" aria-label="Mood">
        <button type="button" className={mood === 'all' ? 'on' : ''} onClick={() => setMood('all')}>Any mood</button>
        {MOODS.map((item) => (
          <button key={item} type="button" className={mood === item ? 'on' : ''} onClick={() => setMood(item)}>{item}</button>
        ))}
      </div>
      <div className="idea-stage">
        <div className="idea-list">
          {list.map((item) => (
            <article key={item.id} className={selected === item.id ? 'on' : ''}>
              <button
                type="button"
                className="idea-row"
                aria-expanded={open === item.id}
                onClick={() => {
                  setSelected(item.id)
                  setOpen(open === item.id ? '' : item.id)
                }}
              >
                <b>{item.name}</b>
                <span>{item.feel}</span>
              </button>
              {open === item.id && (
                <IdeaBody
                  item={item}
                  root={scale.root}
                  favorite={scale.favorites.includes(item.id)}
                  onHear={() => hear(item)}
                  onUse={() => store.insertIdea(item.id, 0)}
                  onFavorite={() => store.toggleFavorite(item.id)}
                  onVariation={(index) => hear(item, item.variations[index]?.chords ?? item.chords)}
                  onSimilar={(id) => {
                    setSelected(id)
                    setOpen(id)
                  }}
                />
              )}
            </article>
          ))}
          {!list.length && <p className="face-hint">No matches.</p>}
        </div>
        {current && (
          <aside className="idea-detail">
            <IdeaBody
              item={current}
              root={scale.root}
              favorite={scale.favorites.includes(current.id)}
              onHear={() => hear(current)}
              onUse={() => store.insertIdea(current.id, 0)}
              onFavorite={() => store.toggleFavorite(current.id)}
              onVariation={(index) => hear(current, current.variations[index]?.chords ?? current.chords)}
              onSimilar={(id) => {
                setSelected(id)
                setOpen(id)
              }}
            />
          </aside>
        )}
      </div>
    </div>
  )
}

function IdeaBody({
  item,
  root,
  favorite,
  onHear,
  onUse,
  onFavorite,
  onVariation,
  onSimilar,
}: {
  item: Progression
  root: number
  favorite: boolean
  onHear: () => void
  onUse: () => void
  onFavorite: () => void
  onVariation: (index: number) => void
  onSimilar: (id: string) => void
}) {
  const names = chordNames(item, root)
  const key = NOTE_NAMES[root]
  return (
    <div className="idea-body">
      <p className="idea-why">{item.why}</p>
      <p className="idea-roman">{romanLine(item.chords)}</p>
      <p className="idea-names">{key} {item.mode} · {names}</p>
      <p className="idea-meta">{item.tempo} bpm · {item.genres[0]}</p>
      <div className="idea-actions">
        <button type="button" onClick={onHear}>Hear</button>
        <button type="button" onClick={onUse}>Use</button>
        <button type="button" className={favorite ? 'on' : ''} aria-pressed={favorite} onClick={onFavorite}>{favorite ? 'Saved' : 'Save'}</button>
      </div>
      {!!item.variations.length && (
        <div className="chip-row">
          {item.variations.map((variation, index) => (
            <button key={variation.name} type="button" onClick={() => onVariation(index)}>{variation.name}</button>
          ))}
        </div>
      )}
      {!!item.similar.length && (
        <div className="chip-row">
          {item.similar.map((id) => {
            const other = progressionById(id)
            if (!other) return null
            return <button key={id} type="button" onClick={() => onSimilar(id)}>{other.name}</button>
          })}
        </div>
      )}
    </div>
  )
}
