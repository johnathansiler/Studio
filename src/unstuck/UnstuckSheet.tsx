import { useEffect, useMemo, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { spellSymbol, type Mode } from '../model/progressions'
import { samplesToBeats } from '../model/time'
import type { ProjectStore } from '../state/store'
import { audition, deriveSongContext, suggest, UNSTUCK_BUTTON, UNSTUCK_TABS, type Suggestion, type SuggestionKind } from './index'

export function UnstuckSheet({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const [tab, setTab] = useState<SuggestionKind>('progression')
  const [heard, setHeard] = useState<string | null>(null)
  const version = store.version
  const context = useMemo(() => {
    const beat = samplesToBeats(engine.positionSamples, store.project.sampleRate, store.project.tempo)
    return deriveSongContext(store.project, beat)
  }, [store, engine, version])
  const items = useMemo(() => suggest(context).filter((item) => item.kind === tab), [context, tab])
  const blurb = UNSTUCK_TABS.find((item) => item.id === tab)?.description ?? UNSTUCK_BUTTON

  useEffect(() => () => engine.stopPreview(), [engine])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function hear(item: Suggestion) {
    engine.unlock()
    engine.previewSequence(audition(context, item))
    setHeard(item.id)
  }

  function useSuggestion(item: Suggestion) {
    engine.stopPreview()
    store.applyUnstuck(item)
    store.toast('Added. Undo takes it back.', 'good')
  }

  return (
    <div className="unstuck-sheet" role="dialog" aria-label="Unstuck" data-unstuck="open">
      <header>
        <strong>Unstuck</strong>
        <button type="button" onClick={onClose} aria-label="Close Unstuck">×</button>
      </header>
      <div className="unstuck-tabs" role="tablist" aria-label="Suggestion kind">
        {UNSTUCK_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'on' : ''}
            aria-label={`${item.label}. ${item.description}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="unstuck-blurb">{blurb}</p>
      <p className="unstuck-blurb">Hear plays it after the last chord. Use writes it, and undo takes it back.</p>
      <div className="unstuck-list">
        {items.map((item) => {
          const names = spelledLine(item.line, context.mode, context.key)
          const bar = Math.floor(item.startBeat / context.beatsPerBar) + 1
          return (
            <article key={item.id} className={heard === item.id ? 'on' : ''} data-id={item.id} data-kind={item.kind}>
              <div className="unstuck-card-top">
                <b>{item.title}</b>
                <span>Bar {bar}</span>
              </div>
              <p className="unstuck-line">{item.line}</p>
              {names && <p className="unstuck-names">{names}</p>}
              <p className="unstuck-why">{item.why}</p>
              <div className="unstuck-actions">
                <button type="button" onClick={() => hear(item)} title="Play it after the last chord, without writing it.">
                  Hear
                </button>
                <button type="button" className="primary" onClick={() => useSuggestion(item)} title="Write it into the song. Undo takes it back.">
                  Use
                </button>
              </div>
            </article>
          )
        })}
        {!items.length && <p className="unstuck-empty">No melody on a MIDI track yet. Add one, and chords can follow it.</p>}
      </div>
    </div>
  )
}

function spelledLine(line: string, mode: Mode, key: number): string {
  if (line.includes(' ') || line.includes('→')) return ''
  const symbols = line.split('–').map((symbol) => symbol.trim()).filter(Boolean)
  if (!symbols.length || !symbols.every((symbol) => /^[#b]*(i{1,3}|iv|vi{0,3}|v)/i.test(symbol))) return ''
  return symbols.map((symbol) => spellSymbol(symbol, mode, key).name).join(' ')
}
