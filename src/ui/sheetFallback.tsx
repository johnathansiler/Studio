import { Component, lazy, Suspense, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { ChunkMiss } from './lazyViews'
import { SheetHeader } from './SheetClose'

/** Same overlay box as an open sheet, so the dock does not jump while the chunk loads. */

export function SheetFallback({
  label,
  className = '',
  onClose,
  failed = false,
  onRetry,
}: {
  label: string
  className?: string
  onClose?: () => void
  failed?: boolean
  onRetry?: () => void
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
      {failed ? (
        <p className="hint">
          Couldn't load — {onRetry ? <button type="button" className="text-btn" onClick={onRetry}>Retry</button> : null}
        </p>
      ) : null}
    </div>
  )
}

export function GenerateFallback({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  return (
    <div className="gen-pop gen-embedded" data-generate="open" aria-label="Generate" aria-busy={failed ? undefined : true}>
      <header>
        <strong>Generate</strong>
      </header>
      {failed ? <ChunkMiss label="Generate" onRetry={onRetry ?? (() => undefined)} /> : null}
    </div>
  )
}

interface BoundaryProps {
  label: string
  className?: string
  onClose: () => void
  onRetry?: () => void
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
      return <SheetFallback label={this.props.label} className={this.props.className} onClose={this.props.onClose} onRetry={this.props.onRetry} failed />
    }
    return this.props.children
  }
}

export function LazySheet<C extends ComponentType<any>>({
  label,
  className = '',
  onClose,
  load,
  children,
}: {
  label: string
  className?: string
  onClose: () => void
  load: (attempt?: number) => Promise<{ default: C }>
  children: (View: ComponentType<ComponentProps<C>>) => ReactNode
}) {
  const [generation, setGeneration] = useState(0)
  const View = useMemo(() => lazy(() => load(generation)), [generation])
  const retry = () => setGeneration((value) => value + 1)
  return (
    <SheetBoundary key={generation} label={label} className={className} onClose={onClose} onRetry={retry}>
      <Suspense fallback={<SheetFallback label={label} className={className} onClose={onClose} />}>
        {children(View as ComponentType<ComponentProps<C>>)}
      </Suspense>
    </SheetBoundary>
  )
}

class GenerateBoundary extends Component<{ onRetry: () => void; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  render() {
    if (this.state.failed) return <GenerateFallback failed onRetry={this.props.onRetry} />
    return this.props.children
  }
}

export function LazyGenerate<C extends ComponentType<any>>({
  load,
  children,
}: {
  load: (attempt?: number) => Promise<{ default: C }>
  children: (View: ComponentType<ComponentProps<C>>) => ReactNode
}) {
  const [generation, setGeneration] = useState(0)
  const View = useMemo(() => lazy(() => load(generation)), [generation])
  const retry = () => setGeneration((value) => value + 1)
  return (
    <GenerateBoundary key={generation} onRetry={retry}>
      <Suspense fallback={<GenerateFallback />}>
        {children(View as ComponentType<ComponentProps<C>>)}
      </Suspense>
    </GenerateBoundary>
  )
}
