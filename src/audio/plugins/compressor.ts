import { createCompressor, moduleFor } from './dynamics'

const plugin = moduleFor('compressor', createCompressor)
export const { descriptor, presets, create } = plugin
export default plugin
