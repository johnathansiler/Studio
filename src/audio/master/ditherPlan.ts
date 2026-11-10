/** Where dither belongs: once, at the integer file, after the limiter has already quantized. */

import type { DitherMode } from '../../model/wav'
import type { Project } from '../../model/types'

export function ditherShape(project: Project): DitherMode {
  const plugin = limiterPlugin(project)
  const bits = plugin?.params.bits ?? 24
  const shape = plugin?.params.shape ?? 0
  if (bits >= 23.5 && shape < 0.5) return 'none'
  if (shape >= 1.5) return 'shaped'
  if (shape >= 0.5) return 'tpdf'
  return 'none'
}

/**
 * The limiter already quantizes when bits are under 24 or noise shaping is on.
 * Export dither runs again only when the file is a lower bit depth than that stage.
 */
export function fileDither(project: Project, fileBits: number, requested: DitherMode): DitherMode {
  if (requested === 'none') return 'none'
  const plugin = limiterPlugin(project)
  if (!plugin) return requested
  const bits = plugin.params.bits ?? 24
  const shape = plugin.params.shape ?? 0
  const already = bits < 23.5 || shape > 0.05
  if (already && bits <= fileBits + 0.5) return 'none'
  return requested
}

function limiterPlugin(project: Project) {
  return [...project.masterPlugins].reverse().find((item) => item.pluginId === 'limiter' && item.enabled)
}
