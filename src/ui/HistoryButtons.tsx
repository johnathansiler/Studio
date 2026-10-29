export function HistoryButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div className="history-btns" role="group" aria-label="History">
      <button type="button" className="text-btn history-btn" data-history="undo" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
        <span className="history-icon" aria-hidden>↶</span>
        <span className="history-word">Undo</span>
      </button>
      <button type="button" className="text-btn history-btn" data-history="redo" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
        <span className="history-icon" aria-hidden>↷</span>
        <span className="history-word">Redo</span>
      </button>
    </div>
  )
}
