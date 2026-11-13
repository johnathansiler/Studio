import { ButtonTray } from './ButtonTray'
import { copyOf, described, studioViewTabs, VIEW_COPY } from './chrome'

export function ViewSwitcher({
  active,
  collabShown,
  phonePane,
  collabBadge,
  onView,
  onCollab,
  onWarm,
}: {
  active: 'arrange' | 'mix' | 'beats' | 'session' | null
  collabShown: boolean
  phonePane: 'edit' | 'room'
  collabBadge: boolean
  onView: (view: 'arrange' | 'mix' | 'beats' | 'session') => void
  onCollab: () => void
  onWarm?: (view: 'arrange' | 'mix' | 'beats' | 'session' | 'collab') => void
}) {
  return (
    <ButtonTray equal className="views">
      <button
        type="button"
        className={`collab-tab ${collabShown ? 'active' : ''}`}
        {...described(copyOf(VIEW_COPY, 'collab'))}
        onPointerEnter={() => onWarm?.('collab')}
        onTouchStart={() => onWarm?.('collab')}
        onClick={onCollab}
      >
        Collab
        {collabBadge && <span className="collab-badge" aria-hidden />}
      </button>
      {studioViewTabs().map((copy) => {
        const view = copy.id as 'arrange' | 'mix' | 'beats' | 'session'
        const on = active != null && !collabShown && (view === 'session' || phonePane !== 'room') && active === view
        return (
          <button
            key={view}
            type="button"
            className={on ? 'active' : ''}
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
