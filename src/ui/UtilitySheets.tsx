import { useSyncExternalStore } from 'react'
import { SNAP_DIVISIONS, normalizeSnapDivision, type SnapDivisionId } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { TOOL_INFO, activeTool, keyForTool, subscribeTools, type ArrangeTool } from '../state/tools'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import { ChoiceChip, ChoiceTray } from './ChoiceTray'
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
    return <ToolChoices store={store} onClose={onClose} />
  }
  if (utility === 'snap') {
    return <SnapChoices store={store} onClose={onClose} />
  }
  return null
}

export function ToolChoices({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const current = TOOL_INFO[value]
  return (
    <ChoiceTray id="tool-choices" label="Select" title="Select" value={current?.label ?? 'Select'} onClose={onClose}>
      {TOOLS.map((id) => {
        const info = TOOL_INFO[id]
        const key = keyForTool(id)
        const name = key ? `${info.label} (${key})` : info.label
        return (
          <ChoiceChip
            key={id}
            label={info.label}
            name={`${name}. ${info.hint}`}
            hint={info.hint}
            pressed={value === id}
            onClick={() => { store.setTool(id); onClose() }}
          />
        )
      })}
    </ChoiceTray>
  )
}

export function SnapChoices({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const on = store.project.snap !== false
  const division = normalizeSnapDivision(store.project.snapDivision)
  const gridLabel = SNAP_DIVISIONS.find((item) => item.id === division)?.label ?? division
  return (
    <ChoiceTray id="snap-choices" label="Snap" title="Snap" value={on ? gridLabel : 'Off'} onClose={onClose}>
      <ChoiceChip
        label={on ? 'On' : 'Off'}
        name={on ? 'Snap On. Press to move in small steps.' : 'Snap Off. Press to land on the grid.'}
        hint={on ? 'Snap is on. Press to move in small steps.' : 'Snap is off. Press to land on the grid.'}
        pressed
        onClick={() => { store.toggle('snap'); onClose() }}
      />
      {SNAP_DIVISIONS.map((item) => (
        <ChoiceChip
          key={item.id}
          label={item.label}
          hint={`Grid size ${item.label}. Used when Snap is on.`}
          pressed={on && item.id === division}
          onClick={() => {
            store.setSnapDivision(item.id as SnapDivisionId)
            if (store.project.snap === false) store.toggle('snap')
            onClose()
          }}
        />
      ))}
    </ChoiceTray>
  )
}
