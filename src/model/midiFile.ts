import type { MidiClip, Project } from './types'

const TICKS = 480

export function encodeMidi(project: Project): Uint8Array {
  const midiTracks = project.tracks.filter((track) => track.midiClips.length)
  const tracks = midiTracks.length ? midiTracks : [{ name: project.name, midiClips: [] as MidiClip[] }]
  const bodies = tracks.map((track, index) => trackBody(track.name, track.midiClips, index === 0 ? project.tempo : 0))
  const header = new Uint8Array(14)
  writeString(header, 0, 'MThd')
  const view = new DataView(header.buffer)
  view.setUint32(4, 6, false)
  view.setUint16(8, 1, false)
  view.setUint16(10, bodies.length, false)
  view.setUint16(12, TICKS, false)
  const total = header.length + bodies.reduce((sum, body) => sum + body.length, 0)
  const out = new Uint8Array(total)
  out.set(header, 0)
  let offset = header.length
  for (const body of bodies) {
    out.set(body, offset)
    offset += body.length
  }
  return out
}

export function midiNoteCount(bytes: Uint8Array): number {
  let notes = 0
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0x90 && bytes[i + 2] > 0) notes += 1
  }
  return notes
}

function trackBody(name: string, clips: MidiClip[], tempo: number) {
  const events: { tick: number; data: number[] }[] = []
  if (tempo > 0) {
    const us = Math.round(60000000 / tempo)
    events.push({ tick: 0, data: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] })
  }
  const title = [...new TextEncoder().encode(name)].slice(0, 80)
  events.push({ tick: 0, data: [0xff, 0x03, title.length, ...title] })
  for (const clip of clips) {
    for (const note of clip.notes) {
      const on = beatsToTicks(clip.startBeat + note.startBeat)
      const off = on + Math.max(1, beatsToTicks(note.durationBeats))
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)))
      const velocity = midiVelocity(note.velocity)
      events.push({ tick: on, data: [0x90, pitch, velocity] })
      events.push({ tick: off, data: [0x80, pitch, velocity] })
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.data[0] - b.data[0])
  const bytes: number[] = []
  let cursor = 0
  for (const event of events) {
    bytes.push(...variable(Math.max(0, event.tick - cursor)))
    bytes.push(...event.data)
    cursor = event.tick
  }
  bytes.push(...variable(0), 0xff, 0x2f, 0x00)
  const chunk = new Uint8Array(8 + bytes.length)
  writeString(chunk, 0, 'MTrk')
  new DataView(chunk.buffer).setUint32(4, bytes.length, false)
  chunk.set(bytes, 8)
  return chunk
}

function midiVelocity(value: number) {
  const scaled = value <= 1 ? value * 127 : value
  return Math.max(1, Math.min(127, Math.round(scaled)))
}

function beatsToTicks(beats: number) {
  return Math.round(beats * TICKS)
}

function variable(value: number) {
  let n = Math.max(0, value)
  const bytes = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return bytes
}

function writeString(bytes: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
}
