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

export interface ToolInfo {
  label: string
  /** Hover and long-press description. */
  hint: string
  /** One-line status while the timeline is the editor. */
  arrange: string
  /** One-line status while the piano roll is open. */
  piano: string
  cursor: string
}

export const TOOL_INFO: Record<ArrangeTool, ToolInfo> = {
  select: {
    label: 'Select',
    hint: 'Tap a clip or note, then drag to move it.',
    arrange: 'Select: tap a clip, drag to move',
    piano: 'Select: tap a note, drag to move',
    cursor: 'default',
  },
  box: {
    label: 'Box',
    hint: 'Drag a rectangle to select several clips or notes.',
    arrange: 'Box: drag to select clips',
    piano: 'Box: drag to select notes',
    cursor: 'crosshair',
  },
  pencil: {
    label: 'Draw',
    hint: 'Tap empty space to add a clip or a note.',
    arrange: 'Draw: tap a lane to add a clip',
    piano: 'Draw: tap to add notes',
    cursor: 'crosshair',
  },
  trim: {
    label: 'Trim',
    hint: 'Drag either end of a clip to change its length.',
    arrange: 'Trim: drag an edge to resize',
    piano: 'Trim: drag a note edge to resize',
    cursor: 'ew-resize',
  },
  split: {
    label: 'Split',
    hint: 'Tap a clip or note where you want the cut.',
    arrange: 'Split: tap a clip to cut it',
    piano: 'Split: tap a note to cut it',
    cursor: 'col-resize',
  },
  erase: {
    label: 'Erase',
    hint: 'Tap a clip or note to delete it. Drag to delete more.',
    arrange: 'Erase: tap a clip to delete it',
    piano: 'Erase: tap a note to delete it',
    cursor: 'crosshair',
  },
  pan: {
    label: 'Pan',
    hint: 'Drag to scroll the timeline or the piano roll.',
    arrange: 'Pan: drag to scroll',
    piano: 'Pan: drag to scroll',
    cursor: 'grab',
  },
  zoom: {
    label: 'Zoom',
    hint: 'Drag sideways on the timeline, or up and down in the piano roll.',
    arrange: 'Zoom: drag sideways to zoom',
    piano: 'Zoom: drag up or down to zoom',
    cursor: 'zoom-in',
  },
}

export const ARRANGE_TOOLS: { id: ArrangeTool; label: string }[] = (
  ['select', 'box', 'pencil', 'trim', 'split', 'erase', 'pan', 'zoom'] as const
).map((id) => ({ id, label: TOOL_INFO[id].label }))

/** First in the phone strip, so they sit on screen before a sideways scroll. */
export const PRIMARY_TOOLS: ArrangeTool[] = ['select', 'pencil', 'erase']

/** Later in the same strip. They are not behind a menu. */
export const SHEET_TOOLS: ArrangeTool[] = ['box', 'trim', 'split', 'pan', 'zoom']

/** Select, Draw, and Erase, then the rest, all on one scrolling row. */
export function compactToolOrder(): ArrangeTool[] {
  return [...PRIMARY_TOOLS, ...SHEET_TOOLS]
}

export const TOOL_ACTIONS = [
  { id: 'duplicate', label: 'Duplicate', hint: 'Copy the selected clips and place them just after.' },
  { id: 'delete', label: 'Delete', hint: 'Remove the selected clips.' },
] as const

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

export function toolChip(tool: ArrangeTool, where: 'arrange' | 'piano') {
  return TOOL_INFO[tool][where]
}

export function toolCursor(tool: ArrangeTool) {
  return TOOL_INFO[tool].cursor
}

/** Tools that must own the gesture. Native scrolling would cancel the drag. */
export function toolClaimsGesture(tool: ArrangeTool) {
  return tool !== 'select'
}
