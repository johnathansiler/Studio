import { useSyncExternalStore, type RefObject } from 'react'
import { SNAP_DIVISIONS, normalizeSnapDivision, type SnapDivisionId } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { TOOL_INFO, activeTool, keyForTool, subscribeTools, type ArrangeTool } from '../state/tools'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import { ChoiceChip, ChoiceTray } from './ChoiceTray'
import { SongPanel } from './SongPanel'
import type { UtilitySheet } from './arrangePanel'
import { useFormFactor } from './form'

/** Tools the choice sheet can offer. Scroll is the pan tool, named so it is not the mixer pan. */
const TRAY_TOOLS: ArrangeTool[] = ['select', 'pencil', 'split', 'trim', 'zoom', 'box', 'erase', 'pan']

export function toolTrayIds(omit: readonly ArrangeTool[] = []) {
  return TRAY_TOOLS.filter((id) => !omit.includes(id))
}

function toolFace(id: ArrangeTool) {
  if (id === 'pan') {
    return { label: 'Scroll', hint: 'Scroll the timeline or the piano roll. This is not the mixer pan.' }
  }
  const info = TOOL_INFO[id]
  return { label: info.label, hint: info.hint }
}

export function UtilitySheets({
  utility,
  store,
  engine,
  session,
  position,
  setupButton,
  onClose,
  onQuickPunch,
  onReset,
  onMidi,
  roomRole,
}: {
  utility: UtilitySheet | null
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  position: number
  setupButton: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onQuickPunch: () => void
  onReset?: () => void
  onMidi?: () => void
  roomRole?: 'host' | 'guest'
}) {
  const phone = useFormFactor() === 'phone'
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
          onReset={onReset}
          onMidi={onMidi}
          roomRole={roomRole}
        />
      </ArrangeBottomSheet>
    )
  }
  if (utility === 'tools') {
    /* Phone draws the eight tools in the dock, lined up on the edit row. */
    if (phone) return null
    return <ToolChoices store={store} onClose={onClose} />
  }
  if (utility === 'snap') {
    return <SnapChoices store={store} onClose={onClose} />
  }
  return null
}

export function ToolChoices({
  store,
  onClose,
  omit = [],
}: {
  store: ProjectStore
  onClose: () => void
  omit?: readonly ArrangeTool[]
}) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const listed = toolTrayIds(omit)
  if (listed.length === 0) return null
  const title = listed.includes('select') ? 'Select' : 'Tools'
  const current = listed.includes(value) ? toolFace(value) : null
  return (
    <ChoiceTray id="tool-choices" label={title} title={title} value={current?.label ?? (TOOL_INFO[value]?.label ?? title)} onClose={onClose}>
      {listed.map((id) => {
        const face = toolFace(id)
        const key = keyForTool(id)
        const name = key ? `${face.label} (${key})` : face.label
        return (
          <ChoiceChip
            key={id}
            label={face.label}
            name={`${name}. ${face.hint}`}
            hint={face.hint}
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
