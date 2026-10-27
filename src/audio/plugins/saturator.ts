import { descriptor, FACTORY } from './catalog'
import { createSaturator } from './color'
import type { PluginModule } from './types'

const plugin: PluginModule = { descriptor: descriptor('saturator')!, presets: FACTORY.saturator, create: createSaturator }
export const { presets, create } = plugin
export default plugin
