import type { Project } from '../model/types'
import { diffCloned, musicalClone, setPath, type RawChange } from './ops'

/** Undo stops retaining steps past this. Older steps drop off the front. */
export const HISTORY_LIMIT = 200

export interface HistoryStep {
  label: string
  undo: RawChange[]
  redo: RawChange[]
}

export interface HistoryKey {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/**
 * Patch journal for project edits.
 * One musical clone is held only while a drag is open. Settled steps keep the
 * changed fields, not another copy of the project.
 */
export class HistoryJournal {
  private past: HistoryStep[] = []
  private future: HistoryStep[] = []
  private anchor: Project | null = null

  get canUndo() {
    return this.past.length > 0 || this.anchor != null
  }

  get canRedo() {
    return this.future.length > 0 && this.anchor == null
  }

  get depth() {
    return this.past.length
  }

  get bytes() {
    try {
      return JSON.stringify(this.past).length + JSON.stringify(this.future).length
    } catch {
      return 0
    }
  }

  /** Remember the project as it is now. Later edits collapse into one step. */
  open(project: Project) {
    if (this.anchor) return
    this.anchor = musicalClone(project)
    this.future = []
  }

  /** Close the open gesture. An unchanged project does not take a step. */
  seal(project: Project): HistoryStep | null {
    if (!this.anchor) return null
    const before = this.anchor
    this.anchor = null
    const after = musicalClone(project)
    const redo = diffCloned(before, after)
    const undo = diffCloned(after, before)
    if (!redo.length && !undo.length) return null
    const step: HistoryStep = { label: labelFor(redo, undo), undo, redo }
    this.past.push(step)
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
    return step
  }

  /** Restore the previous step. An open drag is sealed first, then undone. */
  undo(project: Project): HistoryStep | null {
    this.seal(project)
    const step = this.past.pop()
    if (!step) return null
    applyChanges(project, step.undo)
    this.future.push(step)
    return step
  }

  redo(project: Project): HistoryStep | null {
    this.seal(project)
    const step = this.future.pop()
    if (!step) return null
    applyChanges(project, step.redo)
    this.past.push(step)
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    return step
  }

  clear() {
    this.past = []
    this.future = []
    this.anchor = null
  }

  /**
   * Fold remote field writes into saved steps so a later undo keeps them.
   * The open drag's anchor is updated too, so the gesture does not undo the remote edit.
   */
  absorb(ops: { p: string; v: unknown }[]) {
    if (!ops.length) return
    if (this.anchor) {
      for (const op of ops) setPath(this.anchor, op.p, cloneValue(op.v))
    }
    this.past = this.past.map((step) => retarget(step, ops))
    this.future = this.future.map((step) => retarget(step, ops))
  }

  mentions(id: string) {
    if (!id) return false
    try {
      return JSON.stringify(this.past).includes(`"${id}"`) || JSON.stringify(this.future).includes(`"${id}"`)
    } catch {
      return false
    }
  }
}

export function applyChanges(project: Project, changes: RawChange[]) {
  for (const change of changes) {
    if (!change.p) continue
    setPath(project, change.p, cloneValue(change.v))
  }
}

function retarget(step: HistoryStep, ops: { p: string; v: unknown }[]): HistoryStep {
  return {
    ...step,
    undo: absorbRemote(step.undo, ops),
    redo: absorbRemote(step.redo, ops),
  }
}

/** Remote values win on the paths they touch, including inside a stored object. */
export function absorbRemote(changes: RawChange[], ops: { p: string; v: unknown }[]): RawChange[] {
  let next = changes.map((change) => ({ p: change.p, v: cloneValue(change.v) }))
  for (const op of ops) {
    const kept: RawChange[] = []
    for (const change of next) {
      if (change.p === op.p) {
        kept.push({ p: change.p, v: cloneValue(op.v) })
        continue
      }
      if (op.p.startsWith(`${change.p}/`) && change.v && typeof change.v === 'object') {
        const copy = cloneValue(change.v)
        setPath(copy as object, op.p.slice(change.p.length + 1), cloneValue(op.v))
        kept.push({ p: change.p, v: copy })
        continue
      }
      if (change.p.startsWith(`${op.p}/`) || change.p === `${op.p}/@order`) continue
      kept.push(change)
    }
    next = kept
  }
  return next
}

function cloneValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  return structuredClone(value)
}

export function labelFor(redo: RawChange[], undo: RawChange[]): string {
  const labels = new Set<string>()
  for (const change of redo) labels.add(labelOne(change, undo))
  if (!labels.size) {
    for (const change of undo) labels.add(labelOne(change, redo))
  }
  if (labels.has('Add clip') && labels.has('Resize clip')) return 'Split clip'
  if (labels.size === 1) return [...labels][0]
  if (labels.has('Move clip')) return 'Move clip'
  if (labels.has('Add track') && labels.has('Add clip')) return 'Add clip'
  return [...labels][0] || 'Edit'
}

function labelOne(change: RawChange, other: RawChange[]): string {
  const path = change.p
  const prior = other.find((item) => item.p === change.p)?.v
  if (path === 'tempo' || path.startsWith('tempoMap')) return 'Tempo'
  if (path === 'timeSignature' || path.startsWith('meterMap')) return 'Time signature'
  if (path === 'loopEnabled' || path === 'loopStartSample' || path === 'loopEndSample') return 'Loop'
  if (path === 'name') return 'Rename project'
  if (path === 'masterVolume') return 'Master volume'
  if (path === 'automationMode' || path === 'masterAutomationMode') return 'Automation'
  if (path.startsWith('automation') || path.startsWith('rackAutomation')) return 'Automation'
  if (path.startsWith('scale')) return 'Scale'
  if (path.startsWith('padKit')) return 'Pads'
  if (path.startsWith('beats')) return 'Drum step'
  if (path === 'tracks/@order') return 'Reorder tracks'
  if (path.includes('/notes')) return 'Edit notes'
  if (path.includes('/clips/') || path.includes('/midiClips/') || path.startsWith('patternClips')) return clipLabel(prior, change.v)
  if (path.startsWith('tracks/')) {
    const rest = path.split('/').slice(2).join('/')
    if (!rest) return change.v == null ? 'Delete track' : 'Add track'
    if (rest === 'name') return 'Rename track'
    if (rest === 'volume') return 'Volume'
    if (rest === 'pan') return 'Pan'
    if (rest === 'automationMode') return 'Automation'
    if (rest === 'mute') return 'Mute'
    if (rest === 'solo' || rest === 'soloSafe') return 'Solo'
    if (rest.startsWith('sends')) return 'Send'
    if (rest.includes('params') || rest.startsWith('plugins') || rest.startsWith('inserts')) return 'Plugin'
    if (rest.includes('sampler') || rest.includes('scaler') || rest.includes('rack') || rest === 'instrument') return 'Instrument'
    return 'Edit track'
  }
  if (path.startsWith('masterPlugins') || path.startsWith('masterInserts')) return 'Plugin'
  return 'Edit'
}

function clipLabel(before: unknown, after: unknown): string {
  if (after == null && before != null) return 'Delete clip'
  if (before == null && after != null) return 'Add clip'
  if (!isRec(before) || !isRec(after)) return 'Edit clip'
  const startMoved = before.startSample !== after.startSample || before.startBeat !== after.startBeat
  const resized = before.durationSamples !== after.durationSamples || before.durationBeats !== after.durationBeats
  if (startMoved && !resized) return 'Move clip'
  if (resized) return 'Resize clip'
  return 'Edit clip'
}

function isRec(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function typingTarget(target: { tagName?: string; isContentEditable?: boolean } | null) {
  if (!target) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable
}

/** Ctrl/Cmd+Z undo. Ctrl/Cmd+Shift+Z, Ctrl+Y, and Shift+Z redo. */
export function historyCommand(event: HistoryKey, typing: boolean): 'undo' | 'redo' | null {
  if (typing) return null
  const key = event.key.toLowerCase()
  const meta = !!(event.metaKey || event.ctrlKey)
  if (meta && key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (event.ctrlKey && key === 'y') return 'redo'
  if (!meta && event.shiftKey && key === 'z') return 'redo'
  return null
}
