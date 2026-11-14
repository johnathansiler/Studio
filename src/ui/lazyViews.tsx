import { Component, lazy, Suspense, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { lastPreloadFailure } from './chunkReload'

declare const __CUEHARBOR_SESSION__: boolean

/**
 * Views that are not on the first Arrange screen.
 * Each factory is a dynamic import so the entry chunk can paint Arrange first.
 * A failed import is not cached: Retry builds a new lazy component.
 */

export function ChunkMiss({ label, className, onRetry }: { label: string; className?: string; onRetry: () => void }) {
  return (
    <div className={['chunk-miss', 'view-pending', className].filter(Boolean).join(' ')} data-chunk-miss="" role="alert">
      <p className="hint">Couldn't load — <button type="button" className="text-btn" onClick={onRetry}>Retry</button></p>
      <span className="sr-only">{label}</span>
    </div>
  )
}

interface BoundaryProps {
  label: string
  className?: string
  onRetry: () => void
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

export class ChunkBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  render() {
    if (this.state.failed) return <ChunkMiss label={this.props.label} className={this.props.className} onRetry={this.props.onRetry} />
    return this.props.children
  }
}

/** A failed dynamic import stays in the browser module map, so Retry has to ask for a new URL. */
export function retryChunkUrl(message: string, attempt: number): string | null {
  const matched = message.match(/https?:\/\/[^\s)'"]+/)
  if (!matched || attempt < 1) return null
  const url = new URL(matched[0])
  url.searchParams.set('cueharbor-retry', String(attempt))
  return url.href
}

/** Null when the module has the named export. Otherwise a message Retry can cache-bust from. */
export function missingExportMessage(mod: unknown, key: string, preloadMessage = ''): string | null {
  if (mod != null && typeof mod === 'object' && (mod as Record<string, unknown>)[key] != null) return null
  return preloadMessage || `Failed to fetch dynamically imported module: missing ${key}`
}

/**
 * Load a named export. A rejected import, a resolved undefined (Vite does this
 * when vite:preloadError is cancelled), or a missing export all take the same
 * retry path: a new URL, because the failed module stays in the browser map.
 */
export function refetchModule<M, K extends keyof M>(
  load: () => Promise<M | null | undefined>,
  key: K,
  attempt: number,
  bust: (url: string) => Promise<M | null | undefined> = (url) => import(/* @vite-ignore */ url),
): Promise<{ default: M[K] }> {
  const read = (mod: M | null | undefined) => {
    const message = missingExportMessage(mod, String(key), lastPreloadFailure())
    if (message) throw new Error(message)
    return { default: (mod as M)[key] }
  }
  return load().then(read).catch((error: unknown) => {
    if (attempt < 1) throw error
    const message = `${error instanceof Error ? error.message : String(error)}\n${lastPreloadFailure()}`
    const url = retryChunkUrl(message, attempt)
    if (!url) throw error
    return bust(url).then(read)
  })
}

/** Name a module export without contextually typing it as ComponentType, which collapses the props to never. */
export function moduleView<M, K extends keyof M>(load: () => Promise<M>, key: K) {
  return (attempt = 0) => refetchModule(load, key, attempt)
}

function retryable<C extends ComponentType<any>>(
  load: (attempt?: number) => Promise<{ default: C }>,
  label: string,
  pendingClass: string,
) {
  // One lazy component for every mount. A resolved chunk does not suspend again
  // when the view moves (phone sheet to side column). Retry replaces it.
  let attempt = 0
  let Current = lazy(() => load(attempt))
  return function RetryableView(props: ComponentProps<C>) {
    const [tick, setTick] = useState(0)
    const retry = () => {
      attempt += 1
      Current = lazy(() => load(attempt))
      setTick(attempt)
    }
    return (
      <ChunkBoundary key={tick} label={label} className={pendingClass} onRetry={retry}>
        <Suspense fallback={<PendingPane className={pendingClass} label={label} />}>
          <Current {...props} />
        </Suspense>
      </ChunkBoundary>
    )
  }
}

export const MixerView = retryable(moduleView(() => import('./MixerView'), 'MixerView'), 'Mix', 'mixer-view')
export const PadsPanel = retryable(moduleView(() => import('./PadsPanel'), 'PadsPanel'), 'Beat Machine', 'mpc')
export const PluginSheet = retryable(moduleView(() => import('./PluginSheet'), 'PluginSheet'), 'Plugin', 'sheet-pending')
export const WaveEditor = retryable(moduleView(() => import('./WaveEditor'), 'WaveEditor'), 'Sample editor', 'wave-editor')
export const MainMenu = retryable(moduleView(() => import('./MainMenu'), 'MainMenu'), 'Menu', 'menu-pending')
export const KeyboardDock = retryable(moduleView(() => import('./KeyboardDock'), 'KeyboardDock'), 'Keyboard', 'keyboard-dock')
export const StepSequencerPanel = retryable(moduleView(() => import('./StepSequencerPanel'), 'StepSequencerPanel'), 'Step sequencer', 'step-sequencer')
export const RackView = retryable(moduleView(() => import('./RackView'), 'RackView'), 'Instrument', 'rack')
export const MidiDock = retryable(moduleView(() => import('./MidiDock'), 'MidiDock'), 'Piano roll', 'midi-dock')
export const ExportSheet = retryable(moduleView(() => import('./ExportSheet'), 'ExportSheet'), 'Export', 'sheet-pending')
export const ProjectSheet = retryable(moduleView(() => import('./ProjectSheet'), 'ProjectSheet'), 'Projects', 'sheet-pending')
export const QuantizeSheet = retryable(moduleView(() => import('./QuantizeSheet'), 'QuantizeSheet'), 'Quantize', 'sheet-pending')
export const PatchSheet = retryable(moduleView(() => import('./PatchSheet'), 'PatchSheet'), 'Patch', 'sheet-pending')
export const PerformPop = retryable(moduleView(() => import('./PerformPop'), 'PerformPop'), 'Perform', 'sheet-pending')
export const VideoDock = retryable(moduleView(() => import('./VideoDock'), 'VideoDock'), 'Collab', 'collab-pending')
export const ShellBrowser = retryable(moduleView(() => import('./PlaylistBrowser'), 'ShellBrowser'), 'Browse', 'playlist-browser')
export const PlaylistBrowser = retryable(moduleView(() => import('./PlaylistBrowser'), 'PlaylistBrowser'), 'Browse', 'playlist-browser')
export const TunerPop = retryable(moduleView(() => import('./AmpPop'), 'TunerPop'), 'Tuner', 'sheet-pending')
export const FaceGallery = retryable(moduleView(() => import('./faces/PluginFace'), 'FaceGallery'), 'Faces', 'view-pending')

export const SessionPane = __CUEHARBOR_SESSION__
  ? retryable(moduleView(() => import('./SessionView'), 'SessionView'), 'Session', 'session-grid')
  : function HiddenSession(_props: Record<string, unknown>) { return null }

const loads: Record<string, () => Promise<unknown>> = {
  mix: () => import('./MixerView'),
  pads: () => import('./PadsPanel'),
  session: () => (__CUEHARBOR_SESSION__ ? import('./SessionView') : Promise.resolve()),
  plugins: () => import('./PluginSheet'),
  wave: () => import('./WaveEditor'),
  menu: () => import('./MainMenu'),
  keys: () => import('./KeyboardDock'),
  steps: () => import('./StepSequencerPanel'),
  rack: () => import('./RackView'),
  piano: () => import('./MidiDock'),
  export: () => import('./ExportSheet'),
  projects: () => import('./ProjectSheet'),
  quantize: () => import('./QuantizeSheet'),
  patch: () => import('./PatchSheet'),
  perform: () => import('./PerformPop'),
  collab: () => import('./VideoDock'),
  browse: () => import('./PlaylistBrowser'),
  tune: () => import('./AmpPop'),
}

const started = new Set<string>()

/** Start a view chunk. A second call does not download it again. */
export function preloadView(id: string) {
  if (started.has(id)) return
  const load = loads[id]
  if (!load) return
  started.add(id)
  void load().catch(() => { started.delete(id) })
}

/** Views a phone is likely to open after Arrange. */
export function preloadStudioIdle() {
  for (const id of ['mix', 'menu', 'pads', 'session', 'plugins', 'piano', 'wave', 'keys', 'browse', 'collab', 'steps', 'export', 'projects']) {
    preloadView(id)
  }
}

/** Fills the pane the real view will occupy, so the chrome does not jump. */
export function PendingPane({ className, label }: { className: string; label: string }) {
  return <div className={`${className} view-pending`} data-view-pending="" aria-busy="true" aria-label={label} />
}

export function PendingMenu() {
  return <div className="menu-pending" data-view-pending="" aria-busy="true" aria-label="Menu" />
}
