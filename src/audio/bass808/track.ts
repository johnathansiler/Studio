/** Put the 808 Bass device on a MIDI track without wiping a patch that is already there. */

import { createPlugin } from '../plugins/catalog'
import { isInstrument, makeDevice, type RackDevice } from '../../model/rack'
import type { Track } from '../../model/types'

export function bassDevice(track: Track | null | undefined): RackDevice | null {
  return track?.rack?.devices.find((device) => device.kind === 'bass808') ?? null
}

export function applyBass808(track: Track) {
  track.instrument = 'bass808'
  const existing = track.rack?.devices.find((device) => device.kind === 'bass808')
  if (!track.rack) {
    track.rack = { devices: [makeDevice('bass808', 'Trap 808')], cables: [], polyphony: 1 }
  } else if (!existing) {
    const kept = track.rack.devices.filter((device) => !isInstrument(device.kind))
    track.rack.devices = [makeDevice('bass808', 'Trap 808'), ...kept]
    track.rack.cables = track.rack.cables ?? []
    track.rack.polyphony = 1
  } else {
    track.rack.devices = track.rack.devices.filter((device) => device.kind === 'bass808' || !isInstrument(device.kind))
    track.rack.polyphony = 1
  }
  if (!track.plugins.some((plugin) => plugin.pluginId === 'bass808')) track.plugins.push(createPlugin('bass808'))
  if (track.omniPatch?.enabled) track.omniPatch.enabled = false
}
