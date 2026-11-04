import type { BufferHint } from '../audio/core/buffer'
import { BUFFER_HINTS } from '../audio/core/buffer'
import { MENU_GROUPS, type MenuSpec } from './chrome'
import { MenuRow } from './Hint'

const METERS = ['4/4', '3/4', '6/8', '5/4', '7/8']

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
}) {
  return (
    <div className="shell-menu" id="shell-menu">
      {MENU_GROUPS.map((group) => {
        const rows = items.filter((item) => item.group === group.id)
        if (!rows.length) return null
        return (
          <section key={group.id} className="menu-group" aria-label={group.label}>
            <p className="menu-heading">{group.label}</p>
            {group.id === 'settings' && onLatency && (
              <label key="latency" className="menu-sig latency-choice" data-menu-action="latency">
                <span>Latency</span>
                <small>{latencyReadout || 'Base not measured. Output not measured.'}</small>
                <select
                  aria-label="Latency. Lowest, Balanced, or Playback."
                  title="Device buffer. Lowest is the shortest wait. Playback is the longest."
                  value={latencyHint ?? 'interactive'}
                  onChange={(event) => onLatency(event.target.value as BufferHint)}
                >
                  {BUFFER_HINTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
            )}
            {rows.map((item) => item.action === 'signature' ? (
              <label key={item.id} className="menu-sig" data-menu-action={item.action}>
                <span>{item.label}</span>
                <small>{item.hint}</small>
                <select
                  aria-label={`${item.label}. ${item.hint}`}
                  title={item.hint}
                  value={signature}
                  disabled={disabled(item.action)}
                  onChange={(event) => {
                    const [numerator, denominator] = event.target.value.split('/').map(Number)
                    onSignature(numerator, denominator)
                  }}
                >
                  {METERS.map((meter) => <option key={meter}>{meter}</option>)}
                </select>
              </label>
            ) : (
              <MenuRow
                key={item.id}
                id={item.action === 'save' ? 'menu-save' : item.action === 'open' ? 'menu-open' : undefined}
                action={item.action}
                label={item.label}
                hint={item.hint}
                pressed={pressed(item.action) || undefined}
                disabled={disabled(item.action)}
                onClick={() => onAction(item.action)}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}
