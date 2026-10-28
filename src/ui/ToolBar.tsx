import { useSyncExternalStore } from 'react'
import { ARRANGE_TOOLS, activeTool, keyForTool, subscribeTools, type ArrangeTool } from '../state/tools'

export function ToolBar({
  onChange,
  onDuplicate,
  onDelete,
}: {
  onChange: (tool: ArrangeTool) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  return (
    <div className="timeline-tools" role="toolbar" aria-label="Tools">
      {ARRANGE_TOOLS.map((tool) => {
        const key = keyForTool(tool.id)
        return (
          <button
            key={tool.id}
            type="button"
            className={`tool ${value === tool.id ? 'on' : ''}`}
            aria-label={tool.label}
            aria-pressed={value === tool.id}
            title={key ? `${tool.label} (${key})` : tool.label}
            onClick={() => onChange(tool.id)}
          >
            <ToolIcon id={tool.id} />
          </button>
        )
      })}
      <span className="tool-gap" />
      <button type="button" className="tool" aria-label="Duplicate" title="Duplicate" onClick={onDuplicate}>
        <ToolIcon id="duplicate" />
      </button>
      <button type="button" className="tool" aria-label="Delete" title="Delete" onClick={onDelete}>
        <ToolIcon id="delete" />
      </button>
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
