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

export const ARRANGE_TOOLS: { id: ArrangeTool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'box', label: 'Box' },
  { id: 'pencil', label: 'Pencil' },
  { id: 'trim', label: 'Trim' },
  { id: 'split', label: 'Split' },
  { id: 'erase', label: 'Erase' },
  { id: 'pan', label: 'Pan' },
  { id: 'zoom', label: 'Zoom' },
]

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
