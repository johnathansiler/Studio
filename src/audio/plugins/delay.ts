import { descriptor, FACTORY } from './catalog'
import { createDelay } from './space'
import type { PluginModule } from './types'

const plugin: PluginModule = { descriptor: descriptor('delay')!, presets: FACTORY.delay, create: createDelay }
export default plugin
