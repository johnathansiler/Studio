import type { ReactNode } from 'react'
import type { BufferHint } from '../audio/core/buffer'
import { BUFFER_HINTS, bufferHintLabel } from '../audio/core/buffer'
import { MENU_GROUPS, type MenuSpec } from './chrome'
import { MenuRow } from './Hint'

const METERS = ['4/4', '3/4', '6/8', '5/4', '7/8']

function Chevron() {
  return (
    <svg className="menu-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SettingRow({
  action,
  label,
  hint,
  value,
  title,
  ariaLabel,
  selectValue,
  disabled,
  onChange,
  children,
}: {
  action: string
  label: string
  hint?: string
  value: string
  title: string
  ariaLabel: string
  selectValue: string
  disabled?: boolean
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="menu-row menu-setting" data-menu-action={action} aria-disabled={disabled || undefined}>
      <span className="menu-copy">
        <span className="menu-label">{label}</span>
        {hint ? <small>{hint}</small> : null}
      </span>
      <span className="menu-value">
        <span>{value}</span>
        <Chevron />
      </span>
      <select
        aria-label={ariaLabel}
        title={title}
        value={selectValue}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  )
}

export function MainMenu({
  items,
  pressed,
  disabled,
  onAction,
  signature,
  onSignature,
  latencyHint,
  latencyReadout,
  onLatency,
  projectName,
  onProjectName,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onIdeas,
}: {
  items: readonly MenuSpec[]
  pressed: (action: string) => boolean
  disabled: (action: string) => boolean
  onAction: (action: string) => void
  signature: string
  onSignature: (numerator: number, denominator: number) => void
  latencyHint?: BufferHint
  latencyReadout?: string
  onLatency?: (hint: BufferHint) => void
  /** Phone keeps the session name here after the top row is removed. */
  projectName?: string
  onProjectName?: (name: string) => void
  /** Phone Collab and Mix reach Undo, Redo, and Ideas from this sheet. */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  onIdeas?: () => void
}) {
  const latencyValue = bufferHintLabel(latencyHint ?? 'interactive')
  const latencyDetail = latencyReadout || 'Base not measured. Output not measured.'
  return (
    <div className="shell-menu" id="shell-menu">
      {onProjectName && (
        <label className="menu-session">
          <span>Session</span>
          <input
            className="project-name"
            aria-label="Project name"
            title="Session name"
            value={projectName ?? ''}
            onChange={(event) => onProjectName(event.target.value)}
          />
        </label>
      )}
      {(onUndo || onRedo || onIdeas) && (
        <section className="menu-group" aria-label="History">
          <p className="menu-heading">History</p>
          <div className="menu-rows">
            {onUndo && (
              <MenuRow action="undo" label="Undo" hint="Undo the last edit." disabled={!canUndo} onClick={onUndo} />
            )}
            {onRedo && (
              <MenuRow action="redo" label="Redo" hint="Redo the edit you undid." disabled={!canRedo} onClick={onRedo} />
            )}
            {onIdeas && (
              <MenuRow action="ideas" label="Ideas" hint="Pick a part, or write a full song. The MIDI stays editable." onClick={onIdeas} />
            )}
          </div>
        </section>
      )}
      {MENU_GROUPS.map((group) => {
        const rows = items.filter((item) => item.group === group.id)
        if (!rows.length && !(group.id === 'settings' && onLatency)) return null
        return (
          <section key={group.id} className="menu-group" aria-label={group.label}>
            <p className="menu-heading">{group.label}</p>
            <div className="menu-rows">
              {group.id === 'settings' && onLatency && (
                <SettingRow
                  action="latency"
                  label="Latency"
                  hint={latencyDetail}
                  value={latencyValue}
                  title="Device buffer. Lowest is the shortest wait. Playback is the longest."
                  ariaLabel={`Latency. ${latencyValue}. ${latencyDetail}`}
                  selectValue={latencyHint ?? 'interactive'}
                  onChange={(value) => onLatency(value as BufferHint)}
                >
                  {BUFFER_HINTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </SettingRow>
              )}
              {rows.map((item) => item.action === 'signature' ? (
                <SettingRow
                  key={item.id}
                  action={item.action}
                  label={item.label}
                  hint={item.hint}
                  value={signature}
                  title={item.hint}
                  ariaLabel={`${item.label}. ${item.hint}`}
                  selectValue={signature}
                  disabled={disabled(item.action)}
                  onChange={(value) => {
                    const [numerator, denominator] = value.split('/').map(Number)
                    onSignature(numerator, denominator)
                  }}
                >
                  {METERS.map((meter) => <option key={meter} value={meter}>{meter}</option>)}
                </SettingRow>
              ) : (
                <MenuRow
                  key={item.id}
                  id={item.action === 'save' ? 'menu-save' : item.action === 'open' ? 'menu-open' : undefined}
                  action={item.action}
                  label={item.label}
                  hint={item.hint}
                  pressed={pressed(item.action) || undefined}
                  disabled={disabled(item.action)}
                  trailing={group.id === 'settings' ? <Chevron /> : undefined}
                  onClick={() => onAction(item.action)}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
