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
}: {
  items: readonly MenuSpec[]
  pressed: (action: string) => boolean
  disabled: (action: string) => boolean
  onAction: (action: string) => void
  signature: string
  onSignature: (numerator: number, denominator: number) => void
}) {
  return (
    <div className="shell-menu" id="shell-menu">
      {MENU_GROUPS.map((group) => {
        const rows = items.filter((item) => item.group === group.id)
        if (!rows.length) return null
        return (
          <section key={group.id} className="menu-group" aria-label={group.label}>
            <p className="menu-heading">{group.label}</p>
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
