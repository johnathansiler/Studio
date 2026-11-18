import type { RefObject } from 'react'
import { ButtonTray } from './ButtonTray'
import { described, studioViewTabs } from './chrome'

const MENU_COPY = {
  id: 'menu',
  label: 'Menu',
  hint: 'Project, edit, view, and settings.',
}

export function ViewSwitcher({
  active,
  phonePane,
  menuOpen,
  menuRef,
  onView,
  onMenu,
  onWarm,
}: {
  active: 'arrange' | 'mix' | 'beats' | 'session' | null
  phonePane: 'edit' | 'room'
  menuOpen: boolean
  menuRef?: RefObject<HTMLButtonElement | null>
  onView: (view: 'arrange' | 'mix' | 'beats' | 'session') => void
  onMenu: () => void
  onWarm?: (view: 'arrange' | 'mix' | 'beats' | 'session' | 'menu') => void
}) {
  return (
    <ButtonTray equal className="views">
      <button
        ref={menuRef}
        type="button"
        className={`menu-btn${menuOpen ? ' active on' : ''}`}
        data-view-tab="menu"
        {...described(MENU_COPY)}
        aria-expanded={menuOpen}
        aria-controls="shell-menu"
        aria-pressed={menuOpen}
        onPointerEnter={() => onWarm?.('menu')}
        onPointerDown={() => onWarm?.('menu')}
        onTouchStart={() => onWarm?.('menu')}
        onClick={onMenu}
      >
        Menu
      </button>
      {studioViewTabs().map((copy) => {
        const view = copy.id as 'arrange' | 'mix' | 'beats' | 'session'
        const on = active != null && (view === 'session' || phonePane !== 'room') && active === view
        return (
          <button
            key={view}
            type="button"
            className={on ? 'active' : ''}
            data-view-tab={view}
            {...described(copy)}
            onPointerEnter={() => onWarm?.(view)}
            onTouchStart={() => onWarm?.(view)}
            onClick={() => onView(view)}
          >
            {copy.label}
          </button>
        )
      })}
    </ButtonTray>
  )
}
