import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { cachedAnalyses, subscribeAnalysis } from '../analysis/cache'
import type { AnalysisResult } from '../analysis/types'
import type { AudioEngine } from '../audio/engine'
import { samplesToBeats } from '../model/time'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from '../ui/form'
import '../ui/guideSheet.css'
import { songContext, suggest } from './index'
import { UNSTUCK_GROUPS, unstuckActions } from './menu'

const NO_ANALYSIS: AnalysisResult[] = []

export function UnstuckSheet({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const [pass, setPass] = useState<Record<string, number>>({})
  const [used, setUsed] = useState<string | null>(null)
  const version = store.version
  const analyses = useSyncExternalStore(subscribeAnalysis, cachedAnalyses, () => NO_ANALYSIS)
  const place = useFormFactor() === 'desk' ? 'pop' : 'sheet'
  const context = useMemo(() => {
    const beat = samplesToBeats(engine.positionSamples, store.project.sampleRate, store.project.tempo)
    return songContext(store.project, beat, analyses)
  }, [store, engine, version, analyses])
  const actions = useMemo(() => unstuckActions(suggest(context), context, pass), [context, pass])

  useEffect(() => () => engine.stopPreview(), [engine])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.unstuck-sheet, .unstuck-btn')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', close)
    }
  }, [onClose])

  function run(key: string) {
    const action = actions.find((item) => item.key === key)
    if (!action) return
    const step = pass[key] ?? 0
    const item = action.items[step % action.items.length]
    engine.stopPreview()
    store.applyUnstuck(item)
    setPass((prev) => ({ ...prev, [key]: step + 1 }))
    setUsed(key)
    store.toast('Added. Undo takes it back.', 'good')
  }

  return (
    <>
      <button type="button" className="guide-scrim" aria-label="Close Unstuck" onClick={onClose} />
      <div className={`guide-sheet unstuck-sheet ${place}`} role="dialog" aria-label="Unstuck" data-unstuck="open">
        {place === 'sheet' && <div className="guide-handle" aria-hidden="true" />}
        <header className="guide-head">
          <div>
            <h2>Unstuck</h2>
            <p>Tap to generate ideas fast. Tap the same idea again for a new variation. Undo takes one tap back.</p>
          </div>
          <button type="button" className="guide-x" onClick={onClose} aria-label="Close Unstuck">Cancel</button>
        </header>
        {UNSTUCK_GROUPS.map((group) => {
          const rows = actions.filter((item) => item.group === group)
          if (!rows.length) return null
          return (
            <section className="guide-section" key={group}>
              <h3>{group}</h3>
              <div className="guide-cards">
                {rows.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`guide-card${used === item.key ? ' on' : ''}`}
                    data-unstuck-action={item.key}
                    title={item.detail}
                    onClick={() => run(item.key)}
                  >
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
        {!actions.length && <p className="guide-note">Nothing to add yet. Record or draw a part, then come back.</p>}
      </div>
    </>
  )
}
