/** Edit tool shared by the arrange toolbar and the piano roll. Switching it is not an undo step. */
export const EDITOR_TOOLS = ['select', 'box', 'pencil', 'split', 'erase', 'pan', 'zoom'] as const

export type EditorTool = (typeof EDITOR_TOOLS)[number]

/** Digit keys select the tool while an editor is open. */
export const EDITOR_TOOL_KEYS: Record<string, EditorTool> = {
  '1': 'select',
  '2': 'box',
  '3': 'pencil',
  '4': 'split',
  '5': 'erase',
  '6': 'pan',
  '7': 'zoom',
}

/** Timeline edge tool. It is not on the 1–7 keys, so the piano roll map stays put. */
export const TRIM_TOOL = 'trim' as const

export type ArrangeTool = EditorTool | typeof TRIM_TOOL

export type ToolPlace = 'arrange' | 'piano'

type ToolCopy = {
  label: string
  /** Cursor for the editor surface while this tool is active. */
  cursor: string
  arrange: string
  piano: string
}

export const TOOLS: Record<ArrangeTool, ToolCopy> = {
  select: { label: 'Select', cursor: 'default', arrange: 'Move clips', piano: 'Move and resize notes' },
  box: { label: 'Box', cursor: 'crosshair', arrange: 'Drag a box to select', piano: 'Drag a box to select notes' },
  pencil: { label: 'Pencil', cursor: 'crosshair', arrange: 'Draw a new clip', piano: 'Draw a note' },
  trim: { label: 'Trim', cursor: 'ew-resize', arrange: 'Drag an edge to trim', piano: 'Trim clips on the timeline' },
  split: { label: 'Split', cursor: 'col-resize', arrange: 'Cut a clip where you tap', piano: 'Cut a note where you tap' },
  erase: { label: 'Erase', cursor: 'cell', arrange: 'Tap a clip to delete it', piano: 'Tap a note to delete it' },
  pan: { label: 'Pan', cursor: 'grab', arrange: 'Drag to scroll the timeline', piano: 'Drag to scroll the roll' },
  zoom: { label: 'Zoom', cursor: 'zoom-in', arrange: 'Drag sideways to zoom', piano: 'Drag up or down to zoom' },
}

/** Tools that stay on screen at phone width. The rest live in More. */
export const PHONE_TOOLS: ArrangeTool[] = ['select', 'pencil', 'split', 'erase']

const ARRANGE_ORDER: ArrangeTool[] = ['select', 'box', 'pencil', 'trim', 'split', 'erase', 'pan', 'zoom']

export const ARRANGE_TOOLS: { id: ArrangeTool; label: string }[] = ARRANGE_ORDER.map((id) => ({
  id,
  label: TOOLS[id].label,
}))

const listeners = new Set<() => void>()
let current: ArrangeTool = 'select'

export function activeTool(): ArrangeTool {
  return current
}

export function setActiveTool(tool: ArrangeTool) {
  if (tool === current) return
  current = tool
  for (const listener of listeners) listener()
}

export function subscribeTools(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function keyForTool(tool: ArrangeTool) {
  return Object.entries(EDITOR_TOOL_KEYS).find(([, value]) => value === tool)?.[0] ?? ''
}

export function toolInfo(tool: ArrangeTool, place: ToolPlace = 'arrange') {
  const copy = TOOLS[tool]
  return {
    id: tool,
    label: copy.label,
    hint: place === 'piano' ? copy.piano : copy.arrange,
    cursor: place === 'piano' && tool === 'trim' ? 'default' : copy.cursor,
  }
}

export function toolCaption(tool: ArrangeTool, place: ToolPlace = 'arrange') {
  const info = toolInfo(tool, place)
  return `${info.label} — ${info.hint}`
}

export function toolsFor(place: ToolPlace): ArrangeTool[] {
  return place === 'piano' ? [...EDITOR_TOOLS] : [...ARRANGE_ORDER]
}

export function phoneTools(place: ToolPlace): ArrangeTool[] {
  const allowed = new Set(toolsFor(place))
  return PHONE_TOOLS.filter((tool) => allowed.has(tool))
}

export function overflowTools(place: ToolPlace): ArrangeTool[] {
  const pinned = new Set(phoneTools(place))
  return toolsFor(place).filter((tool) => !pinned.has(tool))
}
