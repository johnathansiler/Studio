/** Same overlay box as an open sheet, so the dock does not jump while the chunk loads. */

export function SheetFallback({ label }: { label: string }) {
  return (
    <div className="sheet-pending" data-screen-overlay="" data-sheet-pending="" role="dialog" aria-label={label} aria-busy="true">
      <p className="hint">{label}</p>
    </div>
  )
}

export function GenerateFallback() {
  return (
    <div className="gen-pop gen-embedded" data-generate="open" aria-label="Generate" aria-busy="true">
      <header>
        <strong>Generate</strong>
      </header>
    </div>
  )
}
