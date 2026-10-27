import { createLimiter, moduleFor } from './dynamics'

const plugin = moduleFor('limiter', createLimiter)
export const { descriptor, presets, create } = plugin
export default plugin
