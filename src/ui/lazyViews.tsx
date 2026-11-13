import { lazy } from 'react'

declare const __CUEHARBOR_SESSION__: boolean

/**
 * Views that are not on the first Arrange screen.
 * Each factory is a dynamic import so the entry chunk can paint Arrange first.
 */

export const MixerView = lazy(() => import('./MixerView').then((mod) => ({ default: mod.MixerView })))
export const PadsPanel = lazy(() => import('./PadsPanel').then((mod) => ({ default: mod.PadsPanel })))
export const PluginSheet = lazy(() => import('./PluginSheet').then((mod) => ({ default: mod.PluginSheet })))
export const WaveEditor = lazy(() => import('./WaveEditor').then((mod) => ({ default: mod.WaveEditor })))
export const MainMenu = lazy(() => import('./MainMenu').then((mod) => ({ default: mod.MainMenu })))
export const KeyboardDock = lazy(() => import('./KeyboardDock').then((mod) => ({ default: mod.KeyboardDock })))
export const StepSequencerPanel = lazy(() => import('./StepSequencerPanel').then((mod) => ({ default: mod.StepSequencerPanel })))
export const RackView = lazy(() => import('./RackView').then((mod) => ({ default: mod.RackView })))
export const MidiDock = lazy(() => import('./MidiDock').then((mod) => ({ default: mod.MidiDock })))
export const ExportSheet = lazy(() => import('./ExportSheet').then((mod) => ({ default: mod.ExportSheet })))
export const ProjectSheet = lazy(() => import('./ProjectSheet').then((mod) => ({ default: mod.ProjectSheet })))
export const QuantizeSheet = lazy(() => import('./QuantizeSheet').then((mod) => ({ default: mod.QuantizeSheet })))
export const PatchSheet = lazy(() => import('./PatchSheet').then((mod) => ({ default: mod.PatchSheet })))
export const PerformPop = lazy(() => import('./PerformPop').then((mod) => ({ default: mod.PerformPop })))
export const VideoDock = lazy(() => import('./VideoDock').then((mod) => ({ default: mod.VideoDock })))
export const ShellBrowser = lazy(() => import('./PlaylistBrowser').then((mod) => ({ default: mod.ShellBrowser })))
export const TunerPop = lazy(() => import('./AmpPop').then((mod) => ({ default: mod.TunerPop })))

export const SessionPane = __CUEHARBOR_SESSION__
  ? lazy(() => import('./SessionView').then((mod) => ({ default: mod.SessionView })))
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
