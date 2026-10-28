import { SAMPLE_CONTROLS } from '../engine/controls'
import type { Articulation, SampleControl, SampleInstrumentDef, SampleZone } from '../engine/types'
import { clampNote, dbToGain, loopFromName, makeZone, triggerFromName } from '../engine/zone'
import { descendants, parseXml, type XmlEl } from './xml'

function num(value: string | undefined, fallback: number) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function enabled(value: string | undefined) {
  if (value == null) return false
  const raw = value.toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function knob(el: XmlEl): SampleControl | null {
  const label = el.attrs.label || el.attrs.parameterName || ''
  if (!label) return null
  const base = SAMPLE_CONTROLS.find((control) => control.name.toLowerCase() === label.toLowerCase())
  const id = base?.id ?? `ui:${label.toLowerCase().replace(/\s+/g, '-')}`
  const min = num(el.attrs.minValue, base?.min ?? 0)
  const max = num(el.attrs.maxValue, base?.max ?? 1)
  return {
    id,
    name: label,
    description: el.attrs.description || `Sets ${label} on this instrument.`,
    min,
    max,
    default: num(el.attrs.value, base?.default ?? min),
    unit: base?.unit ?? '',
    step: base?.step ?? (max - min <= 2 ? 0.01 : 1),
  }
}

/** Parse a DecentSampler .dspreset. Sample paths are resolved by the importer. */
export function parseDspreset(text: string, name = 'Decent Sampler'): { def: SampleInstrumentDef } {
  const root = parseXml(text)
  const groups = descendants(root, 'group')
  const zones: SampleZone[] = []
  const articulations: Articulation[] = []
  let random = false
  for (const group of groups) {
    const groupName = group.attrs.name || group.attrs.tags || ''
    const keyswitch = group.attrs.keyswitch != null ? clampNote(num(group.attrs.keyswitch, -1)) : -1
    const articulation = keyswitch >= 0 ? groupName || `sw-${keyswitch}` : group.attrs.articulation || ''
    if (articulation && !articulations.some((item) => item.id === articulation)) {
      articulations.push({
        id: articulation,
        name: groupName || articulation,
        keyswitch,
        description: keyswitch >= 0 ? `Keyswitch ${keyswitch} selects ${groupName || articulation}.` : `Articulation ${groupName || articulation}.`,
      })
    }
    const seqMode = (group.attrs.seqMode || '').toLowerCase()
    if (seqMode.includes('random')) random = true
    const samples = group.children.filter((child) => child.name === 'sample')
    const seqLength = seqMode ? samples.length : 1
    const mic = (group.attrs.mic || group.attrs.tags || '').replace(/^mic:/i, '')
    samples.forEach((sample, index) => {
      const path = sample.attrs.path || sample.attrs.file || ''
      if (!path) return
      const rootNote = clampNote(num(sample.attrs.rootNote ?? sample.attrs.root, 60))
      const loopOn = enabled(sample.attrs.loopEnabled) || sample.attrs.loopStart != null
      const sampleSwitch = sample.attrs.keyswitch != null ? clampNote(num(sample.attrs.keyswitch, -1)) : -1
      const sampleArticulation = sampleSwitch >= 0 ? `sw-${sampleSwitch}` : articulation
      if (sampleSwitch >= 0 && !articulations.some((item) => item.id === sampleArticulation)) {
        articulations.push({
          id: sampleArticulation,
          name: sampleArticulation,
          keyswitch: sampleSwitch,
          description: `Keyswitch ${sampleSwitch} selects this sample group.`,
        })
      }
      zones.push(makeZone({
        id: `ds-${zones.length + 1}`,
        sampleId: path.replace(/\\/g, '/'),
        root: rootNote,
        loKey: clampNote(num(sample.attrs.loNote, rootNote)),
        hiKey: clampNote(num(sample.attrs.hiNote, rootNote)),
        loVel: Math.max(0, Math.min(127, Math.round(num(sample.attrs.loVel, 0)))),
        hiVel: Math.max(0, Math.min(127, Math.round(num(sample.attrs.hiVel, 127)))),
        tune: num(sample.attrs.tuning, 0),
        gain: dbToGain(num(sample.attrs.volume, 0) + num(group.attrs.volume, 0)),
        pan: Math.max(-1, Math.min(1, num(sample.attrs.pan, 0) / 100)),
        start: Math.max(0, Math.round(num(sample.attrs.start, 0))),
        end: Math.max(0, Math.round(num(sample.attrs.end, 0))),
        loopStart: Math.max(0, Math.round(num(sample.attrs.loopStart, 0))),
        loopEnd: Math.max(0, Math.round(num(sample.attrs.loopEnd, 0))),
        loopMode: loopOn ? loopFromName(sample.attrs.loopMode || 'loop') : 'none',
        loopCrossfade: Math.max(0, Math.round(num(sample.attrs.loopCrossfade, 0))),
        seqPosition: seqLength > 1 ? Math.max(1, Math.round(num(sample.attrs.seqPosition, index + 1))) : 0,
        seqLength: seqLength > 1 ? seqLength : 1,
        articulation: sampleArticulation,
        mic: (sample.attrs.mic || mic || '').trim(),
        trigger: triggerFromName(sample.attrs.trigger || group.attrs.trigger || 'attack'),
        attack: group.attrs.attack != null ? num(group.attrs.attack, 0) : null,
        decay: group.attrs.decay != null ? num(group.attrs.decay, 0) : null,
        sustain: group.attrs.sustain != null ? num(group.attrs.sustain, 1) : null,
        release: group.attrs.release != null ? num(group.attrs.release, 0) : null,
      }))
    })
  }
  const mics = [...new Set(zones.map((zone) => zone.mic).filter(Boolean))].map((id) => ({
    id,
    name: id,
    gain: 1,
    description: `Level of the ${id} microphone.`,
  }))
  const controls = descendants(root, 'labeled-knob').map(knob).filter((control): control is SampleControl => Boolean(control))
  if (random) {
    const rr = SAMPLE_CONTROLS.find((control) => control.id === 'rrMode')!
    controls.push({ ...rr, default: 1, description: 'Imported as random round-robin. 1 picks a different take each note.' })
  }
  const title = descendants(root, 'decentsampler')[0]?.attrs.name || name
  return {
    def: {
      id: `ds-${title}`,
      name: title,
      zones,
      articulations,
      mics,
      defaultArticulation: articulations[0]?.id ?? '',
      controls,
    },
  }
}
