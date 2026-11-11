import { Component, Suspense, type ReactNode } from 'react'
import { SheetHeader } from './SheetClose'

/** Same overlay box as an open sheet, so the dock does not jump while the chunk loads. */

export function SheetFallback({
  label,
  className = '',
  onClose,
  failed = false,
}: {
  label: string
  className?: string
  onClose?: () => void
  failed?: boolean
}) {
  return (
    <div
      className={['sheet-pending', className].filter(Boolean).join(' ')}
      data-screen-overlay=""
      data-sheet-pending=""
      role="dialog"
      aria-label={label}
      aria-busy={failed ? undefined : true}
    >
      {onClose ? <SheetHeader title={<strong>{label}</strong>} onClose={onClose} /> : <p className="hint">{label}</p>}
      {failed ? <p className="hint">{label} did not load.</p> : null}
    </div>
  )
}

export function GenerateFallback({ failed = false }: { failed?: boolean }) {
  return (
    <div className="gen-pop gen-embedded" data-generate="open" aria-label="Generate" aria-busy={failed ? undefined : true}>
      <header>
        <strong>Generate</strong>
      </header>
      {failed ? <p className="gen-hint">Generate did not load.</p> : null}
    </div>
  )
}

interface BoundaryProps {
  label: string
  className?: string
  onClose: () => void
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

/** A failed chunk stays on the same sheet instead of taking down the studio. */
class SheetBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return <SheetFallback label={this.props.label} className={this.props.className} onClose={this.props.onClose} failed />
    }
    return this.props.children
  }
}

export function LazySheet({
  label,
  className = '',
  onClose,
  children,
}: {
  label: string
  className?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <SheetBoundary label={label} className={className} onClose={onClose}>
      <Suspense fallback={<SheetFallback label={label} className={className} onClose={onClose} />}>
        {children}
      </Suspense>
    </SheetBoundary>
  )
}

class GenerateBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  render() {
    if (this.state.failed) return <GenerateFallback failed />
    return this.props.children
  }
}

export function LazyGenerate({ children }: { children: ReactNode }) {
  return (
    <GenerateBoundary>
      <Suspense fallback={<GenerateFallback />}>
        {children}
      </Suspense>
    </GenerateBoundary>
  )
}
