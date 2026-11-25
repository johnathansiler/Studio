export function PianoRollButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`piano-roll-btn${className ? ` ${className}` : ''}`} aria-label="Piano Roll" title="Piano Roll" onClick={onClick}>
      <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">
        <rect x="0.5" y="2" width="3.2" height="12" rx="0.6" fill="currentColor" />
        <rect x="5.2" y="2" width="3.2" height="12" rx="0.6" fill="currentColor" />
        <rect x="9.9" y="2" width="3.2" height="12" rx="0.6" fill="currentColor" />
        <rect x="14.6" y="2" width="3.2" height="12" rx="0.6" fill="currentColor" />
        <rect x="2.6" y="2" width="2" height="7" rx="0.4" fill="currentColor" />
        <rect x="7.3" y="2" width="2" height="7" rx="0.4" fill="currentColor" />
        <rect x="12" y="2" width="2" height="7" rx="0.4" fill="currentColor" />
      </svg>
    </button>
  )
}
