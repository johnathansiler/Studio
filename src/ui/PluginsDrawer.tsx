import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isSoundPlugin } from '../instruments/scaler/chain'
import type { PluginInstance } from '../model/types'
import type { ProjectStore } from '../state/store'
import { addInsert, insertLabel, insertMenuChoices } from './PluginSheet'
import './pluginsDrawer.css'

/** One line under each plugin in the add list. */
const NOTES: Record<string, string> = {
  steps: 'A grid of notes you step through.',
  pads: 'Drum pads for one-shots and kits.',
  synth: 'A keyboard instrument that plays notes.',
  sampler: 'Play a recording across the keys.',
  scaler: 'Chords and scales in front of the sound.',
  tune: 'Pulls sung notes onto the song key.',
  eq: 'Shapes the lows, mids, and highs.',
  saturator: 'Adds drive, tape, or an amp.',
  mod: 'Chorus, phase, and other movement.',
  compressor: 'Evens out loud and quiet parts.',
  vocal: 'Tames harshness and gates the vocal.',
  reverb: 'Adds a room, plate, or hall.',
  delay: 'Repeats the sound in time.',
  limiter: 'Holds peaks under a ceiling.',
}

const GROUPS: { id: string; title: string; ids: string[] }[] = [
  { id: 'instruments', title: 'Instruments', ids: ['steps', 'pads', 'synth', 'sampler', 'scaler'] },
  { id: 'pitch', title: 'Pitch', ids: ['tune'] },
  { id: 'tone', title: 'Tone', ids: ['eq', 'saturator', 'mod'] },
  { id: 'dynamics', title: 'Dynamics', ids: ['compressor', 'vocal'] },
  { id: 'space', title: 'Space', ids: ['reverb', 'delay'] },
  { id: 'loudness', title: 'Loudness', ids: ['limiter'] },
]

export type ChainBand = 'midi' | 'instrument' | 'effect'

const BAND_TITLE: Record<ChainBand, string> = {
  midi: 'MIDI',
  instrument: 'Instrument',
  effect: 'Effects',
}

export function pluginNote(id: string) {
  return NOTES[id] ?? ''
}

export function chainBand(plugin: { pluginId: string; params?: Record<string, number> }): ChainBand {
  if (plugin.pluginId === 'scaler' || plugin.pluginId === 'steps') return 'midi'
  if (isSoundPlugin(plugin) || plugin.pluginId === 'drums' || plugin.pluginId === 'drum-machine') return 'instrument'
  return 'effect'
}

/** Consecutive runs in processing order. MIDI and instruments lead a normal chain, then effects. */
export function chainBands(plugins: readonly PluginInstance[]) {
  const groups: { band: ChainBand; plugins: PluginInstance[] }[] = []
  for (const plugin of plugins) {
    const band = chainBand(plugin)
    const last = groups[groups.length - 1]
    if (!last || last.band !== band) groups.push({ band, plugins: [plugin] })
    else last.plugins.push(plugin)
  }
  return groups
}

export function groupInsertChoices(choices: readonly { id: string; name: string }[]) {
  const used = new Set<string>()
  const groups = GROUPS.map((group) => {
    const items = group.ids.flatMap((id) => {
      const found = choices.find((item) => item.id === id)
      if (!found) return []
      used.add(id)
      return [found]
    })
    return { id: group.id, title: group.title, items }
  }).filter((group) => group.items.length > 0)
  const rest = choices.filter((item) => !used.has(item.id))
  if (rest.length) groups.push({ id: 'more', title: 'More', items: [...rest] })
  return groups
}

export function PluginsDrawer({
  store,
  place,
  menuOpen = false,
}: {
  store: ProjectStore
  place: 'bottom' | 'side'
  menuOpen?: boolean
}) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const trackId = store.selectedTrackId
  const [menu, setMenu] = useState(menuOpen)
  const previous = useRef(trackId)
  useEffect(() => {
    if (previous.current === trackId) return
    previous.current = trackId
    setMenu(false)
  }, [trackId])
  return <PluginsDrawerView store={store} place={place} trackId={trackId} menuOpen={menu} onMenu={setMenu} />
}

export function PluginsDrawerView({
  store,
  place,
  trackId,
  menuOpen,
  onMenu,
}: {
  store: ProjectStore
  place: 'bottom' | 'side'
  trackId: string | null
  menuOpen: boolean
  onMenu: (open: boolean) => void
}) {
  const track = trackId ? store.track(trackId) : null
  const plugins = track?.plugins ?? []
  const bands = chainBands(plugins)
  const choices = track ? insertMenuChoices(store, track.id) : []
  const groups = groupInsertChoices(choices)
  return (
    <section
      className="plugins-drawer"
      id="arrange-plugins"
      data-place={place}
      data-plugins-panel="open"
      aria-label={track ? `Plugins on ${track.name}` : 'Plugins'}
    >
      <div className="plugins-drawer-body">
        <header className="plugins-drawer-head">
          <strong>Plugins</strong>
          <span>{track ? track.name : 'No track'}</span>
        </header>
        <p className="plugins-drawer-note">
          {track ? `${track.name}. In the order sound passes through.` : 'Tap a track header to load its plugins.'}
        </p>
        {track && (
          <button
            type="button"
            className="btn-primary plugins-add"
            aria-expanded={menuOpen}
            aria-controls="arrange-plugin-menu"
            title="Add a plugin to this track."
            onClick={() => onMenu(!menuOpen)}
          >
            Add Plugin
          </button>
        )}
        {track && menuOpen && (
          <div className="plugins-menu" id="arrange-plugin-menu" role="group" aria-label="Add a plugin">
            {groups.map((group) => (
              <section key={group.id} className="plugins-group" data-plugin-group={group.id}>
                <h3>{group.title}</h3>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="btn-secondary plugins-choice"
                    data-plugin-choice={item.id}
                    title={pluginNote(item.id) || item.name}
                    onClick={() => {
                      addInsert(store, track.id, item.id)
                      onMenu(false)
                    }}
                  >
                    <strong>{item.name}</strong>
                    {pluginNote(item.id) ? <small>{pluginNote(item.id)}</small> : null}
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}
        {track && plugins.length === 0 && <p className="plugins-empty">No plugins on this track yet.</p>}
        {track && bands.map((group, groupIndex) => (
          <section key={`${group.band}-${groupIndex}`} className="plugins-band" data-chain-band={group.band}>
            <h3>{BAND_TITLE[group.band]}</h3>
            {group.plugins.map((plugin) => {
              const index = plugins.findIndex((item) => item.id === plugin.id)
              const name = insertLabel(plugin.pluginId, plugin)
              return (
                <article
                  key={plugin.id}
                  className={`plugin-row${plugin.enabled ? '' : ' is-off'}`}
                  data-plugin-id={plugin.id}
                  data-chain-plugin={plugin.pluginId}
                  data-chain-index={index}
                  data-bypassed={plugin.enabled ? 'off' : 'on'}
                >
                  <div className="plugin-row-name">
                    <strong>{name}</strong>
                  </div>
                  <div className="plugin-row-actions">
                    <button
                      type="button"
                      className={`btn-quiet plugins-pill${plugin.enabled ? '' : ' on'}`}
                      data-for={plugin.id}
                      data-action="bypass"
                      aria-pressed={!plugin.enabled}
                      title={plugin.enabled ? `Bypass ${name}.` : `Turn ${name} back on.`}
                      onClick={() => store.updatePlugin(track.id, plugin.id, { enabled: !plugin.enabled })}
                    >
                      {plugin.enabled ? 'Bypass' : 'Bypassed'}
                    </button>
                    <button
                      type="button"
                      className="btn-quiet plugins-pill"
                      data-for={plugin.id}
                      data-action="open"
                      title={`Open ${name}.`}
                      onClick={() => store.focusPlugin(track.id, plugin.id)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="btn-quiet plugins-pill"
                      data-for={plugin.id}
                      data-action="earlier"
                      disabled={index <= 0}
                      title="Move this plugin earlier in the chain."
                      onClick={() => { if (index > 0) store.movePlugin(track.id, plugin.id, -1) }}
                    >
                      Earlier
                    </button>
                    <button
                      type="button"
                      className="btn-quiet plugins-pill"
                      data-for={plugin.id}
                      data-action="later"
                      disabled={index < 0 || index >= plugins.length - 1}
                      title="Move this plugin later in the chain."
                      onClick={() => { if (index >= 0 && index < plugins.length - 1) store.movePlugin(track.id, plugin.id, 1) }}
                    >
                      Later
                    </button>
                    <button
                      type="button"
                      className="btn-quiet plugins-pill"
                      data-for={plugin.id}
                      data-action="remove"
                      title={`Remove ${name}.`}
                      onClick={() => store.removePlugin(track.id, plugin.id)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              )
            })}
          </section>
        ))}
      </div>
    </section>
  )
}
