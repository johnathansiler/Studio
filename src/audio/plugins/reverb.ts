import { descriptor, FACTORY } from './catalog'
import { createReverb } from './space'
import type { PluginModule } from './types'

const plugin: PluginModule = { descriptor: descriptor('reverb')!, presets: FACTORY.reverb, create: createReverb }
export default plugin
