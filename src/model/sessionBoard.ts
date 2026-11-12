import type { MidiFxKind, Track, TrackInstrument } from './types'

export const CLIP_SWATCHES = ['#e35d5d', '#e09a3a', '#e6d15a', '#7dce6a', '#3cbfa0', '#5aa7e0', '#8b78e0', '#d36bb5']

export type BrowserGroup = 'sounds' | 'instruments' | 'drums' | 'audio' | 'midi' | 'plugins'

export interface BrowserDevice {
  id: string
  name: string
  hint: string
  kind: 'audio' | 'midi' | 'instrument' | 'drum'
}

export const AUDIO_DEVICES: BrowserDevice[] = [
  { id: 'tune', name: 'Auto-Tune', hint: 'Pull notes toward the song key.', kind: 'audio' },
  { id: 'eq', name: 'EQ', hint: 'Shape lows, mids, and highs.', kind: 'audio' },
  { id: 'compressor', name: 'Comp', hint: 'Even out the level.', kind: 'audio' },
  { id: 'vocal', name: 'Vocal Clean', hint: 'De-ess and gate a voice.', kind: 'audio' },
  { id: 'saturator', name: 'Sat', hint: 'Add harmonic grit.', kind: 'audio' },
  { id: 'delay', name: 'Delay', hint: 'Repeat the sound in time.', kind: 'audio' },
  { id: 'reverb', name: 'Reverb', hint: 'Add room and space.', kind: 'audio' },
  { id: 'mod', name: 'Mod', hint: 'Chorus, phase, and width.', kind: 'audio' },
  { id: 'limiter', name: 'Master Limiter', hint: 'Catch peaks at the ceiling.', kind: 'audio' },
]

export const MIDI_DEVICES: BrowserDevice[] = [
  { id: 'scale', name: 'Scaler', hint: 'Lock notes to a scale and stack chords.', kind: 'midi' },
  { id: 'arp', name: 'Arpeggio', hint: 'Turn a held chord into a pattern.', kind: 'midi' },
  { id: 'chord', name: 'Chord', hint: 'Add chord tones above the note.', kind: 'midi' },
]

export const INSTRUMENT_DEVICES: BrowserDevice[] = [
  { id: 'steps', name: 'Step Sequencer', hint: 'Program beats on a step grid. The sound stays on this track.', kind: 'instrument' },
  { id: 'pads', name: 'Beat Machine', hint: 'Banks of drum and sample pads. Record on this track.', kind: 'instrument' },
  { id: 'synth', name: 'Synth', hint: 'A played synthesizer.', kind: 'instrument' },
  { id: 'sampler', name: 'Sampler', hint: 'Play a loaded sample across the keys.', kind: 'instrument' },
  { id: 'library', name: 'Library', hint: 'A multi-sampled instrument from the library.', kind: 'instrument' },
]

export const DRUM_DEVICES: BrowserDevice[] = [
  { id: 'pads', name: 'Beat Machine', hint: 'Banks of drum and sample pads. Record on this track.', kind: 'drum' },
  { id: 'drum-machine', name: 'Kit', hint: 'Kick, snare, clap, hat, and perc.', kind: 'drum' },
  { id: '808', name: '808', hint: 'Bass and drum machine.', kind: 'drum' },
]

export const PLUGIN_DEVICES: BrowserDevice[] = [
  AUDIO_DEVICES[0],
  { id: 'steps', name: 'Step Sequencer', hint: 'Program beats on a step grid. The sound stays on this track.', kind: 'instrument' },
  { id: 'pads', name: 'Beat Machine', hint: 'Banks of drum and sample pads. Record on this track.', kind: 'instrument' },
  { id: 'scaler', name: 'Scaler', hint: 'Chord instrument. Key, pads, and progressions.', kind: 'instrument' },
  { id: 'synth', name: 'Synth', hint: 'A played synthesizer.', kind: 'instrument' },
  { id: 'sampler', name: 'Sampler', hint: 'Play a loaded sample across the keys.', kind: 'instrument' },
]

export function browserGroup(group: BrowserGroup): BrowserDevice[] {
  if (group === 'instruments') return INSTRUMENT_DEVICES
  if (group === 'drums') return DRUM_DEVICES
  if (group === 'audio') return AUDIO_DEVICES
  if (group === 'midi') return MIDI_DEVICES
  if (group === 'plugins') return PLUGIN_DEVICES
  return []
}

export function deviceDrag(item: BrowserDevice): string {
  if (item.kind === 'audio') return `cueharbor-device:audio:${item.id}`
  if (item.kind === 'midi') return `cueharbor-device:midi:${item.id}`
  return `cueharbor-device:instrument:${item.id}`
}

export function parseDeviceDrag(value: string): { kind: 'audio' | 'midi' | 'instrument'; id: string } | null {
  const match = /^cueharbor-device:(audio|midi|instrument):([a-z0-9-]+)$/.exec(value)
  if (!match) return null
  return { kind: match[1] as 'audio' | 'midi' | 'instrument', id: match[2] }
}

export function clipPaint(clip: { color?: string } | null | undefined, trackColor: string): string {
  return clip?.color || trackColor
}

export function sceneTitle(names: string[] | undefined, scene: number): string {
  const named = names?.[scene]?.trim()
  return named || `Scene ${scene + 1}`
}

export function instrumentFor(id: string): TrackInstrument | null {
  if (id === 'synth' || id === 'sampler' || id === 'library' || id === '808' || id === 'drum-machine' || id === 'scaler' || id === 'pads' || id === 'none') return id
  return null
}

export function midiKind(id: string): MidiFxKind | null {
  if (id === 'arp' || id === 'chord' || id === 'scale') return id
  return null
}

/** Phone starts with the grid only. Browser, mixer, and detail open from the bar. */
export function sessionPanes(phone: boolean): { browser: boolean; detail: boolean; mixer: boolean } {
  if (phone) return { browser: false, detail: false, mixer: false }
  return { browser: true, detail: true, mixer: true }
}

export function sessionTracks(tracks: Track[]): Track[] {
  return tracks.filter((track) => track.type === 'audio' || track.type === 'midi')
}

/** A simple response curve for a device face. Not a measurement, just the control shape. */
export function curvePath(kind: string, values: Record<string, number>): string {
  const pts: string[] = []
  for (let i = 0; i <= 20; i++) {
    const x = i * 10
    const t = i / 20
    let y = 27
    if (kind === 'eq') {
      const low = (values.lowG ?? 0) / 18
      const mid = (values.midG ?? 0) / 18
      const high = (values.highG ?? 0) / 18
      const bump = t < 0.33 ? low * (1 - t / 0.33) : t < 0.66 ? mid * (1 - Math.abs(t - 0.5) / 0.16) : high * ((t - 0.66) / 0.34)
      y = 27 - bump * 18
    } else if (kind === 'compressor' || kind === 'gate' || kind === 'limiter') {
      const ratio = Math.max(1, values.ratio ?? values.amount ?? 1)
      const env = Math.exp(-t * (4 + (values.attack ?? 10) / 20))
      y = 40 - env * (18 / Math.min(8, ratio))
    } else if (kind === 'tune' || kind === 'scale') {
      const step = Math.round(t * 7)
      y = 40 - (step % 5) * 5
    } else {
      y = 27 - Math.sin(t * Math.PI * 2) * 10 * (values.mix ?? values.depth ?? values.amount ?? 0.6)
    }
    pts.push(`${i === 0 ? 'M' : 'L'}${x} ${Math.max(4, Math.min(50, y)).toFixed(1)}`)
  }
  return pts.join(' ')
}
