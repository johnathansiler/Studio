import { useRef, useState, useSyncExternalStore } from 'react'
import { sampleLoadState, subscribeSampleLoad } from '../audio/sampleLoadBus'
import { factoryHarborPresets, harborPluginId, harborPresetChoices, presetParams, type HarborPreset } from '../harbor/presets'
import { articulationsIn } from '../harbor/program'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'

export function HarborProgress({ label = 'Loading zones' }: { label?: string }) {
  const state = useSyncExternalStore(subscribeSampleLoad, sampleLoadState, sampleLoadState)
  if (state.fault && state.pending <= 0) return <p className="sound-status" role="alert">{state.fault}</p>
  if (state.pending <= 0) return null
  return (
    <p className="harbor-progress" role="status" data-harbor-progress="on">
      <progress value={Number.isFinite(state.ratio) ? state.ratio : 0} max={1} />
      <span>{state.fault || label}</span>
    </p>
  )
}

export function HarborPresetBar({ store, trackId }: { store: ProjectStore; trackId: string }) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const program = store.track(trackId)?.library
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  if (!program?.id.startsWith('harbor:')) return null
  const loaded = program
  const articulations = articulationsIn(program)
  const choices = harborPresetChoices({ id: program.id, articulations }, store.project.presets)
  const active = choices.find((item) => {
    const play = program.play
    if (!play) return false
    const samePlay = play.attack === item.play.attack && play.release === item.play.release && play.sustain === item.play.sustain
    const index = articulations.indexOf(item.articulation)
    const selected = articulations.length < 2 || program.defaultSwitch === index
    return samePlay && selected
  }) ?? choices[0]

  function apply(preset: HarborPreset) {
    const current = store.track(trackId)?.library
    if (!current) return
    const names = articulationsIn(current)
    const index = Math.max(0, names.indexOf(preset.articulation))
    store.setLibrary(trackId, {
      ...current,
      play: { ...preset.play },
      defaultSwitch: names.length > 1 ? index : null,
    })
    setOpen(false)
  }

  function save() {
    const clean = name.trim()
    if (!clean) return
    if (factoryHarborPresets({ articulations }).some((item) => item.name.toLowerCase() === clean.toLowerCase())) return
    const preset = choices.find((item) => item.name === active?.name) ?? choices[0]
    store.savePluginPreset(harborPluginId(loaded.id), clean, presetParams(preset, articulations))
    setName('')
  }

  return (
    <div className="harbor-presets" data-harbor-presets={program.id}>
      <button
        ref={button}
        type="button"
        className="sound-filter"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Factory and saved presets for this instrument."
        onClick={() => setOpen((value) => !value)}
      >
        {active?.name ?? 'Preset'}
      </button>
      <AnchoredMenu className="sound-filter-menu harbor-menu" open={open} onClose={() => setOpen(false)} label="Presets" triggerRef={button}>
        <div className="filter-row" role="group" aria-label="Presets">
          {choices.map((preset) => (
            <button
              key={`${preset.source}:${preset.id}`}
              type="button"
              className={`filter-choice${active?.name === preset.name ? ' on' : ''}`}
              aria-pressed={active?.name === preset.name}
              onClick={() => apply(preset)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </AnchoredMenu>
      <input aria-label="Preset name" placeholder="Preset name" value={name} onChange={(event) => setName(event.target.value)} />
      <button type="button" className="sound-add" title="Save this preset on the instrument." onClick={save}>Save</button>
    </div>
  )
}
