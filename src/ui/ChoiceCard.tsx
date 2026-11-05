/** A labeled dropdown. The label sits above a full-width select. */
export function ChoiceCard({
  label,
  hint,
  value,
  options,
  onChange,
  mark,
}: {
  label: string
  hint: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  mark?: string
}) {
  const known = options.some((item) => item.value === value)
  return (
    <label className="choice-card" title={hint}>
      <span>{label}</span>
      <select aria-label={label} data-preset={mark} value={known ? value : options[0]?.value ?? value} onChange={(event) => onChange(event.target.value)}>
        {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        {!known && value && <option value={value}>{value}</option>}
      </select>
    </label>
  )
}
