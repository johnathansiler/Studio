import { useSyncExternalStore } from 'react'
import { SNAP_DIVISIONS, normalizeSnapDivision, type SnapDivisionId } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { TOOL_INFO, activeTool, keyForTool, subscribeTools, type ArrangeTool } from '../state/tools'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import { SongPanel } from './SongPanel'
import type { UtilitySheet } from './arrangePanel'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import type { RefObject } from 'react'

const TOOLS: ArrangeTool[] = ['select', 'pencil', 'split', 'trim', 'zoom', 'box', 'erase']

export function UtilitySheets({
  utility,
  store,
  engine,
  session,
  position,
  setupButton,
  onClose,
  onQuickPunch,
}: {
  utility: UtilitySheet | null
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  position: number
  setupButton: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onQuickPunch: () => void
}) {
  if (utility === 'setup') {
    return (
      <ArrangeBottomSheet id="arrange-setup" label="Setup" title="Setup" onClose={onClose}>
        <SongPanel
          store={store}
          engine={engine}
          session={session}
          position={position}
          compact
          triggerRef={setupButton}
          onClose={onClose}
          onQuickPunch={onQuickPunch}
        />
      </ArrangeBottomSheet>
    )
  }
  if (utility === 'tools') {
    return (
      <ArrangeBottomSheet id="tool-choices" label="Select" title="Select" detail="Choose how a tap on the timeline behaves." onClose={onClose}>
        <ToolChoices store={store} onClose={onClose} />
      </ArrangeBottomSheet>
    )
  }
  if (utility === 'snap') {
    return (
      <ArrangeBottomSheet id="snap-choices" label="Snap" title="Snap" onClose={onClose}>
        <SnapChoices store={store} onClose={onClose} />
      </ArrangeBottomSheet>
    )
  }
  return null
}

function ToolChoices({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  return (
    <div className="arrange-choices" role="listbox" aria-label="Tools">
      {TOOLS.map((id) => {
        const info = TOOL_INFO[id]
        const key = keyForTool(id)
        const label = key ? `${info.label} (${key})` : info.label
        return (
          <button
            key={id}
            type="button"
            className={value === id ? 'on' : ''}
            aria-pressed={value === id}
            title={info.hint}
            aria-label={`${label}. ${info.hint}`}
            onClick={() => { store.setTool(id); onClose() }}
          >
            <strong>{info.label}</strong>
          </button>
        )
      })}
    </div>
  )
}

function SnapChoices({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const on = store.project.snap !== false
  const division = normalizeSnapDivision(store.project.snapDivision)
  return (
    <div className="arrange-choices" role="listbox" aria-label="Snap">
      <button
        type="button"
        className={on ? 'on' : ''}
        aria-pressed={on}
        title={on ? 'Snap is on. Press to move in small steps.' : 'Snap is off. Press to land on the grid.'}
        onClick={() => { store.toggle('snap'); onClose() }}
      >
        <strong>{on ? 'Snap On' : 'Snap Off'}</strong>
      </button>
      {SNAP_DIVISIONS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={on && item.id === division ? 'on' : ''}
          aria-pressed={on && item.id === division}
          title={`Grid size ${item.label}. Used when Snap is on.`}
          onClick={() => {
            store.setSnapDivision(item.id as SnapDivisionId)
            if (store.project.snap === false) store.toggle('snap')
            onClose()
          }}
        >
          <strong>{item.label}</strong>
        </button>
      ))}
    </div>
  )
}
