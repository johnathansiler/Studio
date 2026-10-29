import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
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
import { useFormFactor } from './form'
import { TipButton } from './Hint'
import './guideSheet.css'

const TOOL_GROUPS: { label: string; ids: ArrangeTool[] }[] = [
  { label: 'Pick and move', ids: ['select', 'box'] },
  { label: 'Edit', ids: ['pencil', 'trim', 'split', 'erase'] },
  { label: 'View', ids: ['pan', 'zoom'] },
]

export function ToolBar({
  onChange,
  onDuplicate,
  onDelete,
  context = 'arrange',
  compact = false,
  phone = false,
  words = false,
  showHint = true,
  onDismissHint,
  panel = false,
  onClose,
}: {
  onChange: (tool: ArrangeTool) => void
  onDuplicate: () => void
  onDelete: () => void
  /** Piano wording when the roll is the editor in front of you. */
  context?: 'arrange' | 'piano'
  /** Phone and foldable: one sideways strip under the status line. */
  compact?: boolean
  /** Portrait phone: short labels and only the tools that fit. */
  phone?: boolean
  /** Foldable: icon plus the short word, same as the phone strip. */
  words?: boolean
  showHint?: boolean
  onDismissHint?: () => void
  /** Grouped sheet. Phone and fold use a bottom sheet. Desk uses a popover. */
  panel?: boolean
  onClose?: () => void
}) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const stripRef = useRef<HTMLDivElement>(null)
  const shown = phone ? (['select', 'pencil', 'split', 'erase'] as ArrangeTool[]) : compact ? compactToolOrder() : ARRANGE_TOOLS.map((tool) => tool.id)
  const chip = toolChip(value, context)
  const showWord = phone || words
  useEffect(() => {
    const strip = stripRef.current
    const button = strip?.querySelector<HTMLButtonElement>('button.on')
    if (!strip || !button) return
    const left = button.offsetLeft
    const right = left + button.offsetWidth
    if (left < strip.scrollLeft) strip.scrollLeft = left - 4
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 4
  }, [value])
  if (panel) {
    return (
      <ToolPanel
        value={value}
        context={context}
        onChange={onChange}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onClose={onClose}
      />
    )
  }
  return (
    <div className="timeline-tools" role="toolbar" aria-label="Tools" data-active-tool={value} data-tool-context={context}>
      {showHint && (
        <span className="tool-chip" role="status" aria-live="polite">
          {chip}
          {onDismissHint && (
            <button type="button" className="chip-hide" aria-label="Hide this hint" title="Hide this hint." onClick={onDismissHint}>Hide</button>
          )}
        </span>
      )}
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
              {showWord && <span className="tool-label">{info.label}</span>}
            </TipButton>
          )
        })}
        {(phone ? TOOL_ACTIONS.filter((action) => action.id === 'delete') : TOOL_ACTIONS).map((action) => (
          <TipButton
            key={action.id}
            className="tool"
            label={action.label}
            hint={action.hint}
            onClick={action.id === 'duplicate' ? onDuplicate : onDelete}
          >
            <ToolIcon id={action.id} />
            {showWord && <span className="tool-label">{action.label}</span>}
          </TipButton>
        ))}
      </div>
    </div>
  )
}

function ToolPanel({
  value,
  context,
  onChange,
  onDuplicate,
  onDelete,
  onClose,
}: {
  value: ArrangeTool
  context: 'arrange' | 'piano'
  onChange: (tool: ArrangeTool) => void
  onDuplicate: () => void
  onDelete: () => void
  onClose?: () => void
}) {
  const place = useFormFactor() === 'desk' ? 'pop' : 'sheet'
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const body = (
    <>
      <button type="button" className="guide-scrim" aria-label="Close tools" onClick={onClose} />
      <div className={`guide-sheet tool-sheet ${place}`} role="dialog" aria-label="Tools" data-tool-panel="open">
        {place === 'sheet' && <div className="guide-handle" aria-hidden="true" />}
        <header className="guide-head">
          <div>
            <h2>Tools</h2>
            <p>Pick how a tap on the timeline behaves. The lit tool is the one in use.</p>
          </div>
          <button type="button" className="guide-x" onClick={onClose} aria-label="Close tools">Cancel</button>
        </header>
        {TOOL_GROUPS.map((group) => (
          <section className="guide-section" key={group.label}>
            <h3>{group.label}</h3>
            <div className="guide-cards">
              {group.ids.map((id) => {
                const info = TOOL_INFO[id]
                const line = context === 'piano' ? info.piano : info.arrange
                return (
                  <button
                    key={id}
                    type="button"
                    className={`guide-card${value === id ? ' on' : ''}`}
                    aria-pressed={value === id}
                    title={info.hint}
                    onClick={() => { onChange(id); onClose?.() }}
                  >
                    <strong>{info.label}</strong>
                    <small>{line}</small>
                  </button>
                )
              })}
              {group.label === 'Edit' && TOOL_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="guide-choice"
                  title={action.hint}
                  onClick={action.id === 'duplicate' ? onDuplicate : onDelete}
                >
                  <strong>{action.label}</strong>
                  <small>{action.hint}</small>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
  if (typeof document === 'undefined') return body
  return createPortal(body, document.body)
}

function ToolIcon({ id }: { id: ArrangeTool | 'duplicate' | 'delete' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (id === 'select') return <svg {...common}><path d="M4 2.5l8 6.2-3.2.6 2.1 4.2-1.8.9-2.1-4.2-3 .9z" /></svg>
  if (id === 'box') return <svg {...common}><rect x="3" y="3.5" width="12" height="11" strokeDasharray="2.2 1.6" /></svg>
  if (id === 'pencil') return <svg {...common}><path d="M11.2 3.2l3.6 3.6L7 14.6 3.2 15l.4-3.8z" /></svg>
  if (id === 'trim') return <svg {...common}><path d="M7 4H4.5v10H7M11 4h2.5v10H11" /></svg>
  if (id === 'split') return <svg {...common}><path d="M3.5 4.5h6.2l2.8 2.2V14H3.5z" /><path d="M9.7 4.5V7h3" /><path d="M12.2 9.2l2.6 2.6M14.8 9.2l-2.6 2.6" /></svg>
  if (id === 'erase') return <svg {...common}><path d="M4 12.5l6.2-6.2 3.3 3.3-6.2 6.2H4zM7.2 14.5h7" /></svg>
  if (id === 'pan') return <svg {...common}><path d="M9 3.2v11.6M3.2 9h11.6M9 3.2L7.2 5M9 3.2l1.8 1.8M9 14.8l-1.8-1.8M9 14.8l1.8-1.8M3.2 9l1.8-1.8M3.2 9l1.8 1.8M14.8 9l-1.8-1.8M14.8 9L13 10.8" /></svg>
  if (id === 'zoom') return <svg {...common}><circle cx="8" cy="8" r="4.2" /><path d="M11.2 11.2L15 15" /></svg>
  if (id === 'duplicate') return <svg {...common}><rect x="6" y="6" width="8" height="8" /><path d="M4 12V4h8" /></svg>
  return <svg {...common}><path d="M4 5h10M7.5 5V3.8h3V5M6 5l.6 9.2h4.8L12 5" /></svg>
}
