import { hidesHardwareMidi } from '../model/midiTools'

export interface MidiPortInfo {
  id: string
  name: string
}

type Handler = (input: MidiPortInfo, data: Uint8Array, timeStamp: number) => void
type EndHandler = (input: MidiPortInfo) => void

const handlers = new Set<Handler>()
const enders = new Set<EndHandler>()
const portListeners = new Set<() => void>()
let access: MIDIAccess | null = null
let opening: Promise<void> | null = null
let inputs: MidiPortInfo[] = []
let outputs: MIDIOutput[] = []
let connected = new Map<string, MidiPortInfo>()

export function hardwareMidiAllowed(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  if (hidesHardwareMidi(userAgent)) return false
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
}

export function onMidiPorts(listener: () => void): () => void {
  portListeners.add(listener)
  void ensureAccess()
  listener()
  return () => {
    portListeners.delete(listener)
  }
}

export function onMidiMessage(handler: Handler): () => void {
  handlers.add(handler)
  void ensureAccess()
  return () => {
    handlers.delete(handler)
  }
}

/** Fires once when a port that was connected disappears or reports disconnected. */
export function onMidiPortEnd(handler: EndHandler): () => void {
  enders.add(handler)
  void ensureAccess()
  return () => {
    enders.delete(handler)
  }
}

export function midiInputs(): MidiPortInfo[] {
  return inputs.slice()
}

export function midiOutputs(): { id: string; name: string; send: (data: number[], time?: number) => void }[] {
  return outputs.map((port) => ({
    id: port.id,
    name: port.name || 'MIDI out',
    send: (data, time) => {
      try {
        port.send(data, time)
      } catch {
        /* port closed */
      }
    },
  }))
}

function ensureAccess() {
  if (!hardwareMidiAllowed() || access || opening) return opening ?? Promise.resolve()
  opening = navigator.requestMIDIAccess().then((next) => {
    access = next
    bind(next)
    next.onstatechange = () => bind(next)
  }).catch(() => undefined)
  return opening
}

function bind(next: MIDIAccess) {
  const live = new Map<string, MidiPortInfo>()
  for (const port of next.inputs.values()) {
    const info = { id: port.id, name: port.name || 'MIDI in' }
    if (port.state !== 'disconnected') live.set(port.id, info)
    port.onmidimessage = (event) => {
      if (!event.data || port.state === 'disconnected') return
      for (const handler of handlers) handler(info, event.data, event.timeStamp)
    }
  }
  for (const [id, info] of connected) {
    if (!live.has(id)) {
      for (const end of enders) end(info)
    }
  }
  connected = live
  inputs = [...next.inputs.values()].map((port) => ({ id: port.id, name: port.name || 'MIDI in' }))
  outputs = [...next.outputs.values()]
  for (const listener of portListeners) listener()
}
