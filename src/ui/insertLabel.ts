import { descriptor } from '../audio/plugins/catalog'
import { pluginIsBeatMachine } from '../instruments/pads/identity'

/** Full plugin names. The strip can ellipsize; the accessible name stays the word. */
export function insertLabel(pluginId: string, plugin?: { pluginId: string; params?: Record<string, number> }) {
  if (pluginId === 'steps') return 'Step Sequencer'
  if (plugin && pluginIsBeatMachine(plugin)) return 'Beat Machine'
  if (pluginId === 'pads' || pluginId === 'drums' || pluginId === 'drum-machine') return 'Beat Machine'
  return descriptor(pluginId)?.name ?? pluginId
}
