import { useEffect, useRef, useState } from 'react'
import type { UserPreset } from '../model/types'
import { loadStoredPresets, removeStoredPreset, writeStoredPreset } from '../presets/idb'
import {
  commitChoice,
  cyclePreset,
  deleteUserPreset,
  describePreset,
  duplicatePreset,
  exportablePresets,
  presetByName,
  presetChoices,
  renameUserPreset,
  saveUserPreset,
} from '../presets/library'
import { importPresetDocument, presetDocument } from '../presets/files'
import { resolveParams } from '../presets/bounds'
import { INIT_NAME, isLibraryPreset, type PresetText } from '../presets/types'
import './presetControls.css'

export function PresetControls({
  pluginId,
  instanceKey,
  values,
  text,
  presets,
  onCommit,
}: {
  pluginId: string
  instanceKey: string
  values: Record<string, number>
  text?: PresetText
  presets: UserPreset[]
  onCommit: (next: { params: Record<string, number>; text?: PresetText; presets: UserPreset[] }) => void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'save' | 'rename' | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [extra, setExtra] = useState<UserPreset[]>([])
  const file = useRef<HTMLInputElement>(null)
  const stored = mergeLibrary(presets, extra, pluginId)
  const view = describePreset(pluginId, values, text, stored, instanceKey)
  const choices = presetChoices(pluginId, stored)
  const active = presetByName(pluginId, stored, view.name)

  useEffect(() => {
    let cancel = false
    void loadStoredPresets().then((rows) => {
      if (!cancel) setExtra(rows.filter((item) => item.pluginId === pluginId))
    })
    return () => { cancel = true }
  }, [pluginId])

  function apply(name: string, library = stored) {
    const preset = presetByName(pluginId, library, name) ?? presetChoices(pluginId, library)[0]
    if (!preset) return
    const committed = commitChoice(library, instanceKey, preset)
    onCommit({ params: committed.params, text: committed.text, presets: committed.presets })
    setOpen(false)
    setMode(null)
    setNote('')
  }

  function keepLibrary(next: UserPreset[], name: string) {
    const committed = commitChoice(next, instanceKey, presetByName(pluginId, next, name)!)
    onCommit({ params: committed.params, text: committed.text, presets: committed.presets })
    const user = next.filter((item) => isLibraryPreset(item) && item.pluginId === pluginId)
    for (const row of user) void writeStoredPreset(row)
    setExtra(user)
  }

  return (
    <div className="preset-dock" data-preset-dock={pluginId}>
      <button type="button" aria-label="Previous preset" onClick={() => apply(cyclePreset(pluginId, stored, view.name, -1).name)}>Previous</button>
      <span className="preset-name" data-preset-name={view.name} data-preset-changed={view.changed ? 'yes' : 'no'}>
        {view.changed && <i className="preset-dot" aria-hidden="true" />}
        <b>{view.name}</b>
      </span>
      <button type="button" aria-label="Next preset" onClick={() => apply(cyclePreset(pluginId, stored, view.name, 1).name)}>Next</button>
      <div className="preset-anchor">
        <button type="button" aria-expanded={open} aria-controls={`${instanceKey}-presets`} onClick={() => { setOpen((value) => !value); setMode(null); setNote('') }}>
          Presets
        </button>
        {open && (
          <div className="preset-menu" id={`${instanceKey}-presets`} role="group" aria-label="Presets">
            {choices.map((item) => (
              <button key={item.id} type="button" className={item.name === view.name ? 'on' : ''} onClick={() => apply(item.name)}>
                {item.name}
              </button>
            ))}
            <div className="preset-actions">
              <button type="button" onClick={() => {
                if (view.source === 'user' && active) {
                  const saved = saveUserPreset(stored, pluginId, active.name, resolveParams(pluginId, values), text)
                  if (saved.preset.id) keepLibrary(saved.presets, active.name)
                  setNote('Saved')
                  return
                }
                setDraft(view.name === INIT_NAME ? '' : view.name)
                setMode('save')
              }}>Save</button>
              <button type="button" onClick={() => { setDraft(''); setMode('save') }}>Save As</button>
              <button type="button" disabled={view.source !== 'user' || !active} onClick={() => { setDraft(view.name); setMode('rename') }}>Rename</button>
              <button type="button" disabled={view.source !== 'user' || !active} onClick={() => {
                if (!active) return
                const next = deleteUserPreset(stored, pluginId, active.id)
                if (!next) return
                void removeStoredPreset(active.id)
                const committed = commitChoice(next, instanceKey, presetByName(pluginId, next, INIT_NAME)!)
                onCommit({ params: committed.params, text: committed.text, presets: committed.presets })
                setExtra(next.filter((item) => isLibraryPreset(item) && item.pluginId === pluginId))
              }}>Delete</button>
              <button type="button" onClick={() => {
                const source = active ?? presetChoices(pluginId, stored)[0]
                const copied = duplicatePreset(stored, pluginId, { ...source, params: resolveParams(pluginId, values), text })
                if (!copied.preset.id) return
                void writeStoredPreset({ id: copied.preset.id, pluginId, name: copied.preset.name, params: copied.preset.params })
                keepLibrary(copied.presets, copied.preset.name)
              }}>Duplicate</button>
              <button type="button" onClick={() => apply(view.name)}>Revert</button>
            </div>
            {(mode === 'save' || mode === 'rename') && (
              <form onSubmit={(event) => {
                event.preventDefault()
                if (mode === 'rename' && active) {
                  const next = renameUserPreset(stored, pluginId, active.id, draft)
                  if (!next) { setNote('That name is already used.'); return }
                  const renamed = next.find((item) => item.id === active.id)
                  if (renamed) void writeStoredPreset(renamed)
                  const committed = commitChoice(next, instanceKey, presetByName(pluginId, next, renamed?.name || draft)!)
                  onCommit({ params: resolveParams(pluginId, values), text, presets: committed.presets })
                  setMode(null)
                  return
                }
                const saved = saveUserPreset(stored, pluginId, draft, resolveParams(pluginId, values), text)
                if (!saved.preset.id) { setNote('Pick a new name. Factory presets stay as they are.'); return }
                void writeStoredPreset({ id: saved.preset.id, pluginId, name: saved.preset.name, params: saved.preset.params })
                keepLibrary(saved.presets, saved.preset.name)
                setMode(null)
              }}>
                <input aria-label="Preset name" value={draft} onChange={(event) => setDraft(event.target.value)} />
                <button type="submit">{mode === 'rename' ? 'Rename' : 'Save'}</button>
              </form>
            )}
            <div className="preset-actions">
              <button type="button" onClick={() => file.current?.click()}>Import</button>
              <button type="button" onClick={() => downloadPreset(pluginId, exportablePresets(pluginId, stored))}>Export</button>
            </div>
            {note && <p className="preset-note" role="status">{note}</p>}
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Import presets"
              onChange={(event) => {
                const picked = event.target.files?.[0]
                event.target.value = ''
                if (!picked) return
                void picked.text().then((raw) => {
                  try {
                    const next = importPresetDocument(stored, pluginId, raw)
                    for (const row of next.filter((item) => isLibraryPreset(item) && item.pluginId === pluginId)) void writeStoredPreset(row)
                    onCommit({ params: resolveParams(pluginId, values), text, presets: next })
                    setNote('Imported')
                  } catch (error) {
                    setNote(error instanceof Error ? error.message : 'Could not import that file.')
                  }
                })
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function mergeLibrary(project: readonly UserPreset[], remote: readonly UserPreset[], pluginId: string): UserPreset[] {
  const ids = new Set(project.map((item) => item.id))
  const added = remote.filter((item) => item.pluginId === pluginId && !ids.has(item.id))
  return [...project, ...added]
}

function downloadPreset(pluginId: string, presets: Array<{ name: string; params: Record<string, number>; text?: PresetText }>) {
  const blob = new Blob([presetDocument(pluginId, presets)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${pluginId}-presets.json`
  link.click()
  URL.revokeObjectURL(url)
}
