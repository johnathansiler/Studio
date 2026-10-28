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

const listeners = new Set<() => void>()
let current: EditorTool = 'select'

export function activeTool(): EditorTool {
  return current
}

export function setActiveTool(tool: EditorTool) {
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

export function keyForTool(tool: EditorTool) {
  return Object.entries(EDITOR_TOOL_KEYS).find(([, value]) => value === tool)?.[0] ?? ''
}
