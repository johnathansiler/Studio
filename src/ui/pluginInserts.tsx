import { useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { orderedInserts } from '../audio/plugins/autoTune'
import { CATALOG, descriptor } from '../audio/plugins/catalog'
import { INSTRUMENT_IDS } from '../audio/plugins/ids'
import { insertsBeatMachine } from '../instruments/pads/identity'
import { chainSections, trackHasScaler } from '../instruments/scaler/chain'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'
import { BevelSelect } from './BevelSelect'
import { TouchSlider } from './kit/controls'
import { insertLabel } from './insertLabel'

export function InsertList({ store, trackId, roomy = false }: { store: ProjectStore; trackId: string | 'master'; roomy?: boolean }) {
  const track = trackId === 'master' ? null : store.track(trackId)
  const plugins = trackId === 'master' ? store.project.masterPlugins : track?.plugins ?? []
  if (track && trackHasScaler(track)) {
    const sections = chainSections(track)
    return (
      <div className="inserts" data-chain="midi-sound">
        <span className="chain-part">MIDI</span>
        {sections.midi.map((plugin) => insertButton(store, trackId, plugin))}
        <span className="chain-part">Sound</span>
        {sections.sound.map((plugin) => insertButton(store, trackId, plugin))}
        {sections.caption && <span className="chain-fallback">{sections.caption}</span>}
        {sections.addInstrument && <AddScalerInstrument store={store} trackId={track.id} />}
        {sections.rest.map((plugin) => insertButton(store, trackId, plugin))}
        <PluginPicker store={store} trackId={trackId} roomy={roomy} />
      </div>
    )
  }
  return (
    <div className="inserts">
      {plugins.map((plugin) => insertButton(store, trackId, plugin))}
      <PluginPicker store={store} trackId={trackId} roomy={roomy} />
    </div>
  )
}

function insertButton(store: ProjectStore, trackId: string | 'master', plugin: { id: string; pluginId: string; enabled: boolean; params?: Record<string, number> }) {
  return (
    <button
      key={plugin.id}
      type="button"
      className={plugin.enabled ? 'on' : ''}
      title={descriptor(plugin.pluginId)?.name ?? plugin.pluginId}
      aria-label={`${descriptor(plugin.pluginId)?.name ?? plugin.pluginId}. Open this insert.`}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event) => {
        event?.stopPropagation()
        event?.preventDefault()
        store.focusPlugin(trackId, plugin.id)
      }}
      onDoubleClick={() => store.updatePlugin(trackId, plugin.id, { enabled: !plugin.enabled })}
    >
      {insertLabel(plugin.pluginId, plugin)}
    </button>
  )
}

function AddScalerInstrument({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        className="insert-add"
        aria-expanded={open}
        aria-label="Add instrument"
        title="Add a synth, sampler, or Beat Machine under Scaler."
        onClick={() => setOpen((value) => !value)}
      >
        Add instrument
      </button>
      <AnchoredMenu className="insert-menu" open={open} onClose={() => setOpen(false)} label="Add instrument" triggerRef={button} prefer="down">
        <button type="button" onClick={() => { store.addScalerSound(trackId, 'synth'); setOpen(false) }}>Synth</button>
        <button type="button" onClick={() => { store.addScalerSound(trackId, 'sampler'); setOpen(false) }}>Sampler</button>
        <button type="button" onClick={() => { store.addScalerSound(trackId, 'pads'); setOpen(false) }}>Beat Machine</button>
      </AnchoredMenu>
    </>
  )
}

export function SendList({ store, trackId, engine, roomy = false }: { store: ProjectStore; trackId: string; engine?: AudioEngine; roomy?: boolean }) {
  const track = store.track(trackId)
  if (!track) return null
  const buses = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== trackId)
  return (
    <div className="sends">
      {track.sends.map((send) => (
        <label key={send.id}>
          <span>{buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'}</span>
          <TouchSlider
            label={`${buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'} level`}
            title="Send level. Latch and touch write this while playing."
            min={0}
            max={1}
            step={0.01}
            value={send.gain}
            fallback={0.25}
            onStart={() => store.beginAutomationTouch()}
            onCommit={() => store.endAutomationTouch()}
            onChange={(value) => {
              const rolling = !!engine && (engine.status === 'playing' || engine.status === 'recording')
              store.setAutomated(
                { trackId, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 },
                value,
                rolling,
                engine?.currentTimelineSample() ?? 0,
              )
            }}
          />
          <button type="button" className={`mini ${send.preFader ? 'on' : ''}`} onClick={() => store.updateSend(trackId, send.id, { preFader: !send.preFader })}>
            {send.preFader ? 'Pre' : 'Post'}
          </button>
          <button type="button" className="mini" onClick={() => store.removeSend(trackId, send.id)}>×</button>
        </label>
      ))}
      {buses.length > 0 && (
        <select className="insert-add" value="" onChange={(event) => event.target.value && store.addSend(trackId, event.target.value)}>
          <option value="">{roomy ? 'Add send' : '+'}</option>
          {buses.map((bus) => (
            <option key={bus.id} value={bus.id}>{bus.name}</option>
          ))}
        </select>
      )}
    </div>
  )
}

export function RouteFields({ store, trackId, labeled = false }: { store: ProjectStore; trackId: string; labeled?: boolean }) {
  const track = store.track(trackId)
  if (!track) return null
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const groups = targets.filter((item) => item.type === 'group')
  const outputLabel = !track.output
    ? (track.input.startsWith('remote:') ? 'Cue' : 'Master')
    : targets.find((item) => item.id === track.output)?.name ?? 'Master'
  const groupLabel = groups.find((item) => item.id === track.groupId)?.name ?? 'No group'
  const output = (
    <BevelSelect
      label="Output"
      hint={`Output. ${outputLabel}`}
      value={track.output ?? ''}
      options={[
        { value: '', label: track.input.startsWith('remote:') ? 'Cue' : 'Master' },
        ...targets.map((item) => ({ value: item.id, label: item.name })),
      ]}
      onChange={(next) => store.updateTrack(track.id, { output: next || null })}
    />
  )
  const group = (
    <BevelSelect
      label="Group"
      hint={`Group. ${groupLabel}`}
      value={track.groupId ?? ''}
      options={[{ value: '', label: 'No group' }, ...groups.map((item) => ({ value: item.id, label: item.name }))]}
      onChange={(next) => store.updateTrack(track.id, { groupId: next || null })}
    />
  )
  if (!labeled) return <div className="route-fields">{output}{group}</div>
  return (
    <div className="route-fields labeled">
      <label className="route-field"><span>Output</span>{output}</label>
      <label className="route-field"><span>Group</span>{group}</label>
    </div>
  )
}

/** Instrument and effect choices. Beat Machine leads the list on a MIDI track. */
export function insertChoices<T extends { id: string; name: string }>(entries: readonly T[], midi: boolean): { id: string; name: string }[] {
  const ordered = orderedInserts(entries)
  if (!midi) return [...ordered]
  return [
    { id: 'steps', name: 'Step Sequencer' },
    { id: 'pads', name: 'Beat Machine' },
    ...ordered.filter((item) => item.id !== 'pads' && item.id !== 'steps'),
  ]
}

/** Same insert list Mix shows for this track. */
export function insertMenuChoices(store: ProjectStore, trackId: string | 'master') {
  const midi = trackId !== 'master' && store.track(trackId)?.type === 'midi'
  return insertChoices(CATALOG.filter((plugin) => trackId !== 'master' || !INSTRUMENT_IDS.has(plugin.id)), midi)
}

/** Same insert action Mix uses. Vocal Clean adds the vocal chain. */
export function addInsert(store: ProjectStore, trackId: string | 'master', value: string) {
  if (!value) return
  if (value === 'vocal' && trackId !== 'master') store.addVocalChain(trackId)
  else store.addPlugin(trackId, value)
}

/** Names that fit a narrow strip. The full name stays on the button label. */
export function clipInsertName(name: string, column: number) {
  const inner = Math.max(28, column - 10)
  const chars = Math.max(3, Math.floor(inner / 7.2))
  if (name.length <= chars) return name
  return `${name.slice(0, Math.max(1, chars - 1))}…`
}

/**
 * The live insert worklet drops only the Step Sequencer.
 * Synth, sampler, Scaler, and Beat Machine stay in that serial chain, so they are not labeled as skipped sources.
 */
export function isInstrumentSource(plugin: { pluginId: string; params?: Record<string, number> }) {
  return plugin.pluginId === 'steps'
}

/** These choices retarget through addPlugin when the clicked strip is not a MIDI track. */
const RETARGET_IDS = new Set(['steps', 'scaler', 'synth'])

export function stripCanHost(store: ProjectStore, trackId: string | 'master', pluginId: string) {
  if (!RETARGET_IDS.has(pluginId) && !insertsBeatMachine(pluginId)) return true
  const track = trackId === 'master' ? null : store.track(trackId)
  return track?.type === 'midi'
}

export function stripSlotChoices(store: ProjectStore, trackId: string | 'master') {
  return insertMenuChoices(store, trackId).filter((plugin) => stripCanHost(store, trackId, plugin.id))
}

/** Strip Add. Refuses a choice that would land on a different track. */
export function addStripInsert(store: ProjectStore, trackId: string | 'master', value: string) {
  if (!value || !stripCanHost(store, trackId, value)) return
  addInsert(store, trackId, value)
}

function audioPlace(index: number, count: number) {
  if (index === 0 && count <= 1) return 'Only audio effect. This processes first, then the fader.'
  if (index === 0) return 'First audio effect. This processes first.'
  if (index === count - 1) return 'Last audio effect. It receives the previous audio effect, then the fader.'
  return 'This audio effect receives the previous audio effect and feeds the next one.'
}

function sourcePlace(name: string, savedIndex: number) {
  return `${name}. Instrument source, saved at position ${savedIndex + 1}. The audio chain skips this slot. It does not process in series.`
}

/** Named insert slots. Top is first in the audio chain. One empty slot adds on this track. */
export function StripInserts({ store, trackId, column }: { store: ProjectStore; trackId: string | 'master'; column: number }) {
  const track = trackId === 'master' ? null : store.track(trackId)
  const plugins = trackId === 'master' ? store.project.masterPlugins : track?.plugins ?? []
  const name = trackId === 'master' ? 'Master' : track?.name ?? 'Track'
  return (
    <div className="strip-rack">
      <p className="strip-inserts-label">Inserts</p>
      <div
        className="strip-inserts"
        role="list"
        data-inserts={trackId}
        data-chain="serial"
        aria-label={`Inserts on ${name}. The top insert processes first. Each insert below receives the one above. The bottom insert is last, then the fader feeds the output.`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {plugins.map((plugin, index) => {
          const full = insertLabel(plugin.pluginId, plugin)
          const source = isInstrumentSource(plugin)
          const audio = plugins.filter((item) => !isInstrumentSource(item))
          const audioIndex = audio.findIndex((item) => item.id === plugin.id)
          const label = source
            ? `${sourcePlace(full, index)} Open this source.`
            : `${full}. Audio effect ${audioIndex + 1} of ${audio.length}. ${audioPlace(audioIndex, audio.length)} Open this effect.`
          return (
            <button
              key={plugin.id}
              type="button"
              role="listitem"
              className={`strip-insert${source ? ' is-source' : ''}${plugin.enabled ? ' on' : ' is-off'}`}
              data-plugin={plugin.id}
              data-plugin-id={plugin.pluginId}
              data-role={source ? 'source' : 'audio'}
              data-chain-index={index}
              data-audio-index={source ? undefined : audioIndex}
              title={label}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                if (trackId !== 'master') store.selectTrack(trackId)
                store.focusPlugin(trackId, plugin.id)
              }}
            >
              <span>{clipInsertName(full, column)}</span>
            </button>
          )
        })}
        <PluginPicker store={store} trackId={trackId} slot order={plugins.length} />
      </div>
    </div>
  )
}

function PluginPicker({ store, trackId, slot = false, order = 0 }: { store: ProjectStore; trackId: string | 'master'; roomy?: boolean; slot?: boolean; order?: number }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const choices = slot ? stripSlotChoices(store, trackId) : insertMenuChoices(store, trackId)
  const name = trackId === 'master' ? 'Master' : store.track(trackId)?.name ?? 'Track'
  const addLabel = `Add insert on ${name}. It is placed at the bottom and processes last, then the fader.`
  return (
    <>
      <button
        ref={button}
        type="button"
        className={slot ? 'strip-insert strip-insert-add' : 'plugin-pick insert-add'}
        aria-expanded={open}
        aria-label={slot ? addLabel : 'Add plugin'}
        title={slot ? addLabel : 'Add an instrument or effect on this track.'}
        data-chain-index={slot ? order : undefined}
        data-add-track={slot ? trackId : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        {slot ? 'Add' : open ? 'Close' : 'Add plugin'}
      </button>
      {open && (
        <AnchoredMenu className="insert-menu" open={open} onClose={() => setOpen(false)} label="Add plugin" triggerRef={button} prefer="auto">
          {choices.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              className="plugin-pick"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                if (trackId !== 'master') store.selectTrack(trackId)
                if (slot) addStripInsert(store, trackId, plugin.id)
                else addInsert(store, trackId, plugin.id)
                setOpen(false)
              }}
            >
              {plugin.name}
            </button>
          ))}
        </AnchoredMenu>
      )}
    </>
  )
}
