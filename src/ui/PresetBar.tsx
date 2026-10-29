export function PresetBar({
  label = 'Preset',
  names,
  active,
  onPick,
}: {
  label?: string
  names: string[]
  active: string
  onPick: (name: string) => void
}) {
  if (!names.length) return null
  return (
    <div className="preset-bar" role="listbox" aria-label={label}>
      <span className="preset-now">{active || 'Custom'}</span>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          role="option"
          aria-selected={name === active}
          className={name === active ? 'on' : ''}
          title={name}
          onClick={() => onPick(name)}
        >
          {name}
        </button>
      ))}
    </div>
  )
}
