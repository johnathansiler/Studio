import { descriptor, FACTORY } from './catalog'
import { createDoubler } from './color'
import type { PluginModule } from './types'

const plugin: PluginModule = { descriptor: descriptor('doubler')!, presets: FACTORY.doubler, create: createDoubler }
export default plugin
