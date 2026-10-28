import { useSyncExternalStore, type ReactNode } from 'react'
import {
  activeTool,
  keyForTool,
  overflowTools,
  phoneTools,
  subscribeTools,
  toolCaption,
  toolInfo,
  toolsFor,
  type ArrangeTool,
  type ToolPlace,
} from '../state/tools'
import { HintButton, MoreItem, MoreMenu } from './hint'

export function ToolBar({
  onChange,
  onDuplicate,
  onDelete,
  compact = false,
}: {
  onChange: (tool: ArrangeTool) => void
  onDuplicate: () => void
  onDelete: () => void
  compact?: boolean
}) {
  return (
    <EditorTools place="arrange" compact={compact} onChange={onChange}>
      {compact ? (
        <>
          <MoreItem label="Duplicate" hint="Copy the selected clips" onClick={onDuplicate} />
          <MoreItem label="Delete" hint="Remove the selected clips" onClick={onDelete} />
        </>
      ) : (
        <>
          <HintButton type="button" className="tool" label="Duplicate" hint="Copy the selected clips" onClick={onDuplicate}>
            <ToolIcon id="duplicate" />
          </HintButton>
          <HintButton type="button" className="tool" label="Delete" hint="Remove the selected clips" onClick={onDelete}>
            <ToolIcon id="delete" />
          </HintButton>
        </>
      )}
    </EditorTools>
  )
}

/** Shared tool strip. `hidden` keeps the mode line and drops the buttons when another strip already shows them. */
export function EditorTools({
  place,
  compact = false,
  hidden = false,
  onChange,
  children,
}: {
  place: ToolPlace
  compact?: boolean
  hidden?: boolean
  onChange: (tool: ArrangeTool) => void
  children?: ReactNode
}) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const info = toolInfo(value, place)
  const visible = compact ? phoneTools(place) : toolsFor(place)
  const overflow = compact ? overflowTools(place) : []
  const overflowOn = overflow.includes(value)
  return (
    <div className="timeline-tools" role="toolbar" aria-label={place === 'piano' ? 'Piano tools' : 'Tools'} data-place={place}>
      {!hidden &&
        visible.map((id) => {
          const tool = toolInfo(id, place)
          const key = keyForTool(id)
          return (
            <HintButton
              key={id}
              type="button"
              className={`tool ${value === id ? 'on' : ''}`}
              label={tool.label}
              hint={tool.hint}
              shortcut={key || undefined}
              aria-pressed={value === id}
              onClick={() => onChange(id)}
            >
              <ToolIcon id={id} />
            </HintButton>
          )
        })}
      {!hidden && compact && (
        <MoreMenu
          label={overflowOn ? info.label : 'More tools'}
          hint={overflowOn ? info.hint : 'Box, pan, zoom, and the other edit tools'}
          trigger={overflowOn ? info.label : 'More'}
          active={overflowOn}
        >
          {overflow.map((id) => {
            const tool = toolInfo(id, place)
            return <MoreItem key={id} label={tool.label} hint={tool.hint} pressed={value === id} onClick={() => onChange(id)} />
          })}
          {children}
        </MoreMenu>
      )}
      {!hidden && !compact && children}
      <p className="tool-mode" aria-live="polite" data-tool={value}>
        <strong>{info.label}</strong>
        <span>{info.hint}</span>
      </p>
      <span className="sr-only">{toolCaption(value, place)}</span>
    </div>
  )
}

export function ToolIcon({ id }: { id: ArrangeTool | 'duplicate' | 'delete' }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 18 18',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
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
