import { descriptor, FACTORY } from './catalog'
import { createChorus } from './color'
import type { PluginModule } from './types'

const plugin: PluginModule = { descriptor: descriptor('chorus')!, presets: FACTORY.chorus, create: createChorus }
export default plugin
