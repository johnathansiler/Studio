import { createDeesser, moduleFor } from './dynamics'

const plugin = moduleFor('deesser', createDeesser)
export const { descriptor, presets, create } = plugin
export default plugin
