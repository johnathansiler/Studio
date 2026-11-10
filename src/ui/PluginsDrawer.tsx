import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isSoundPlugin } from '../instruments/scaler/chain'
import type { PluginInstance } from '../model/types'
import type { ProjectStore } from '../state/store'
import { SheetGrab } from './bottomSheet'
import { SheetHeader } from './SheetClose'
import { addInsert, insertLabel, insertMenuChoices } from './PluginSheet'
import './pluginsDrawer.css'
import './pluginPages.css'

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
  onClose,
}: {
  store: ProjectStore
  place: 'bottom' | 'side'
  menuOpen?: boolean
  onClose?: () => void
}) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const trackId = store.selectedTrackId
  const [menu, setMenu] = useState(menuOpen)
  const [groupId, setGroupId] = useState('instruments')
  const [moreAt, setMoreAt] = useState(0)
  const previous = useRef(trackId)
  useEffect(() => {
    if (previous.current === trackId) return
    previous.current = trackId
    setMenu(false)
  }, [trackId])
  useEffect(() => {
    if (place !== 'bottom' || !onClose) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      queueMicrotask(() => {
        if (event.defaultPrevented) return
        if (document.querySelector('.anchored-menu[data-open="true"]:not([hidden])')) return
        onClose()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [place, onClose])
  return <PluginsDrawerView store={store} place={place} trackId={trackId} menuOpen={menu} onMenu={setMenu} onClose={onClose} groupId={groupId} onGroup={setGroupId} moreAt={moreAt} onMore={setMoreAt} />
}

export function PluginsDrawerView({
  store,
  place,
  trackId,
  menuOpen,
  onMenu,
  onClose,
  groupId,
  onGroup,
  moreAt = 0,
  onMore,
}: {
  store: ProjectStore
  place: 'bottom' | 'side'
  trackId: string | null
  menuOpen: boolean
  onMenu: (open: boolean) => void
  onClose?: () => void
  groupId?: string
  onGroup?: (id: string) => void
  moreAt?: number
  onMore?: (index: number) => void
}) {
  const track = trackId ? store.track(trackId) : null
  const plugins = track?.plugins ?? []
  const bands = chainBands(plugins)
  const choices = track ? insertMenuChoices(store, track.id) : []
  const groups = groupInsertChoices(choices)
  const activeGroup = groupId && groups.some((group) => group.id === groupId) ? groupId : groups[0]?.id
  const chooseGroup = onGroup ?? (() => undefined)
  const chooseMore = onMore ?? (() => undefined)
  const sheet = place === 'bottom'
  return (
    <section
      className={`plugins-drawer${sheet ? ' bottom-sheet' : ''}`}
      data-plugin-root=""
      data-plugin-pages=""
      id="arrange-plugins"
      data-place={place}
      data-bottom-sheet={sheet ? 'open' : undefined}
      data-plugins-panel="open"
      aria-label={track ? `Plugins on ${track.name}` : 'Plugins'}
      onPointerDown={sheet ? (event) => event.stopPropagation() : undefined}
    >
      {sheet && <SheetGrab label="Resize plugins. Drag up or down." />}
      {onClose ? (
        <SheetHeader
          className="plugins-drawer-head"
          title={<strong>Plugins</strong>}
          detail={<span>{track ? track.name : 'No track'}</span>}
          onClose={onClose}
        />
      ) : (
        <header className="plugins-drawer-head sheet-head">
          <strong>Plugins</strong>
          <span>{track ? track.name : 'No track'}</span>
        </header>
      )}
      <div className={`plugins-drawer-body${sheet ? ' bottom-sheet-body' : ''}`}>
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
            {groups.length <= 4 && (
            <div className="plugin-page-tabs" role="tablist" aria-label="Plugin groups">
              {groups.map((group) => (
                <button key={group.id} type="button" role="tab" data-plugin-tab={group.id} aria-selected={group.id === activeGroup} className={group.id === activeGroup ? 'on' : ''} onClick={() => chooseGroup(group.id)}>{group.title}</button>
              ))}
            </div>
            )}
            {groups.length > 4 && (
              <label className="plugin-page-menu">
                <span>Group</span>
                <select aria-label="Plugin group" value={activeGroup} onChange={(event) => chooseGroup(event.target.value)}>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}
                </select>
              </label>
            )}
            {groups.map((group) => (
              <section key={group.id} className="plugins-group" data-plugin-group={group.id} data-plugin-page={group.id} hidden={group.id !== activeGroup}>
                <h3>{group.title}</h3>
                {group.id === 'more' && group.items.length > 6 && (
                  <label className="plugin-page-menu">
                    <span>More</span>
                    <select aria-label="More plugins" value={moreAt} onChange={(event) => chooseMore(Number(event.target.value))}>
                      {Array.from({ length: Math.ceil(group.items.length / 6) }, (_, index) => (
                        <option key={index} value={index}>{group.items[index * 6]?.name} to {group.items[Math.min(group.items.length - 1, index * 6 + 5)]?.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {group.items.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className="btn-secondary plugins-choice"
                    hidden={group.id === 'more' && (index < moreAt * 6 || index >= moreAt * 6 + 6)}
                    data-plugin-choice={item.id}
                    title={pluginNote(item.id) || item.name}
                    onClick={() => {
                      addInsert(store, track.id, item.id)
                      onMenu(false)
                      const landed = store.track(track.id)?.plugins.some((plugin) => plugin.pluginId === item.id)
                      if (landed) return
                      const host = store.project.tracks.find((candidate) => candidate.plugins.some((plugin) => plugin.pluginId === item.id))
                      if (host && host.id !== track.id) store.selectTrack(host.id)
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
