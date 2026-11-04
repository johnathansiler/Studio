import { copyOf, described, studioViewTabs, VIEW_COPY } from './chrome'

export function ViewSwitcher({
  active,
  collabShown,
  phonePane,
  collabBadge,
  onView,
  onCollab,
}: {
  active: 'arrange' | 'mix' | 'beats' | 'session' | null
  collabShown: boolean
  phonePane: 'edit' | 'room'
  collabBadge: boolean
  onView: (view: 'arrange' | 'mix' | 'beats' | 'session') => void
  onCollab: () => void
}) {
  return (
    <div className="views">
      <button
        type="button"
        className={`collab-tab ${collabShown ? 'active' : ''}`}
        {...described(copyOf(VIEW_COPY, 'collab'))}
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
            onClick={() => onView(view)}
          >
            {copy.label}
          </button>
        )
      })}
    </div>
  )
}
