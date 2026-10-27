import { createGate, moduleFor } from './dynamics'

const plugin = moduleFor('gate', createGate)
export const { descriptor, presets, create } = plugin
export default plugin
