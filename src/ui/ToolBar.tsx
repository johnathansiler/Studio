import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  ARRANGE_TOOLS,
  TOOL_ACTIONS,
  TOOL_INFO,
  activeTool,
  compactToolOrder,
  keyForTool,
  subscribeTools,
  toolChip,
  type ArrangeTool,
} from '../state/tools'
import { TipButton } from './Hint'

export function ToolBar({
  onChange,
  onDuplicate,
  onDelete,
  context = 'arrange',
  compact = false,
}: {
  onChange: (tool: ArrangeTool) => void
  onDuplicate: () => void
  onDelete: () => void
  /** Piano wording when the roll is the editor in front of you. */
  context?: 'arrange' | 'piano'
  /** Phone and foldable: one sideways strip under the status line. */
  compact?: boolean
}) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const stripRef = useRef<HTMLDivElement>(null)
  const shown = compact ? compactToolOrder() : ARRANGE_TOOLS.map((tool) => tool.id)
  const chip = toolChip(value, context)
  useEffect(() => {
    const strip = stripRef.current
    const button = strip?.querySelector<HTMLButtonElement>('button.on')
    if (!strip || !button) return
    const left = button.offsetLeft
    const right = left + button.offsetWidth
    if (left < strip.scrollLeft) strip.scrollLeft = left - 4
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 4
  }, [value])
  return (
    <div className="timeline-tools" role="toolbar" aria-label="Tools" data-active-tool={value} data-tool-context={context}>
      <span className="tool-chip" role="status" aria-live="polite">
        {chip}
      </span>
      <div className="tool-strip" ref={stripRef}>
        {shown.map((id) => {
          const info = TOOL_INFO[id]
          const key = keyForTool(id)
          const label = key ? `${info.label} (${key})` : info.label
          return (
            <TipButton
              key={id}
              className={`tool ${value === id ? 'on' : ''}`}
              label={label}
              hint={info.hint}
              pressed={value === id}
              onClick={() => onChange(id)}
            >
              <ToolIcon id={id} />
            </TipButton>
          )
        })}
        {TOOL_ACTIONS.map((action) => (
          <TipButton
            key={action.id}
            className="tool"
            label={action.label}
            hint={action.hint}
            onClick={action.id === 'duplicate' ? onDuplicate : onDelete}
          >
            <ToolIcon id={action.id} />
          </TipButton>
        ))}
      </div>
    </div>
  )
}

function ToolIcon({ id }: { id: ArrangeTool | 'duplicate' | 'delete' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (id === 'select') return <svg {...common}><path d="M4 2.5l8 6.2-3.2.6 2.1 4.2-1.8.9-2.1-4.2-3 .9z" /></svg>
  if (id === 'box') return <svg {...common}><rect x="3" y="3.5" width="12" height="11" strokeDasharray="2.2 1.6" /></svg>
  if (id === 'pencil') return <svg {...common}><path d="M11.2 3.2l3.6 3.6L7 14.6 3.2 15l.4-3.8z" /></svg>
  if (id === 'trim') return <svg {...common}><path d="M6 4.5v9M12 4.5v9M6 9h6" /></svg>
  if (id === 'split') return <svg {...common}><path d="M5 14.5l3.2-9.2M13 14.5L9.8 5.3M9 3.2v2.2" /></svg>
  if (id === 'erase') return <svg {...common}><path d="M4 12.5l6.2-6.2 3.3 3.3-6.2 6.2H4zM7.2 14.5h7" /></svg>
  if (id === 'pan') return <svg {...common}><path d="M9 3.2v11.6M3.2 9h11.6M9 3.2L7.2 5M9 3.2l1.8 1.8M9 14.8l-1.8-1.8M9 14.8l1.8-1.8M3.2 9l1.8-1.8M3.2 9l1.8 1.8M14.8 9l-1.8-1.8M14.8 9L13 10.8" /></svg>
  if (id === 'zoom') return <svg {...common}><circle cx="8" cy="8" r="4.2" /><path d="M11.2 11.2L15 15" /></svg>
  if (id === 'duplicate') return <svg {...common}><rect x="6" y="6" width="8" height="8" /><path d="M4 12V4h8" /></svg>
  return <svg {...common}><path d="M4 5h10M7.5 5V3.8h3V5M6 5l.6 9.2h4.8L12 5" /></svg>
}
