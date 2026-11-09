/**
 * Walk effect, mixer, and transport controls and write docs/controls-audit-effects.md.
 * Instruments, Beat Machine, Scaler, and Auto-Tune are owned by another audit.
 */
import { writeFileSync } from 'node:fs'
import { CORE_CATALOG } from '../src/audio/plugins/coreCatalog.ts'
import { kindLabels, paramsForKind } from '../src/audio/plugins/ids.ts'
import { controlLabel, controlText } from '../src/audio/plugins/readout.ts'

const SKIP = new Set(['tune', 'scaler', 'synth', 'sampler'])

/** DSP or the printed value changed in this audit. */
const FIXED = new Set([
  'eq:phase', 'eq:pLow', 'eq:pBoost', 'eq:pAtten', 'eq:pHigh', 'eq:pWidth', 'eq:pCut', 'eq:pCutF',
  'eq:preHp', 'eq:preLow', 'eq:preMid', 'eq:preHigh', 'eq:curve', 'eq:lfF', 'eq:lmfF', 'eq:hmfF', 'eq:hfF', 'eq:tiltF',
  'eq:dynamic', 'eq:linear',
  'compressor:fetRatio', 'compressor:busRatio', 'compressor:busAtk', 'compressor:busRel', 'compressor:variTime',
  'compressor:releaseMode', 'compressor:optoPeak',
  'saturator:speed', 'saturator:color', 'saturator:clipMode', 'saturator:bass', 'saturator:mid', 'saturator:treble', 'saturator:presence',
  'reverb:mode', 'reverb:ir',
  'delay:time',
  'mod:mode', 'mod:speed', 'mod:width',
  'limiter:threshold', 'limiter:bits', 'limiter:shape', 'limiter:bass', 'limiter:lookahead', 'limiter:release', 'limiter:releaseMode',
])

/** No direct min/default/max assertion yet. */
const UNVERIFIED = new Set([
  'vocal:gateAtk', 'vocal:gateRel', 'vocal:hold',
  'eq:dynQ', 'eq:dynR',
  'limiter:low', 'limiter:high',
])

const TEST = 'src/test/effect-controls.test.ts'

interface Row {
  control: string
  label: string
  fn: string
  status: 'ok' | 'fixed' | 'removed' | 'unverified'
  test: string
}

const rows: Row[] = []

for (const plugin of CORE_CATALOG) {
  if (SKIP.has(plugin.id)) continue
  const kinds = kindLabels(plugin.id)
  for (let kind = 0; kind < Math.max(1, kinds.length); kind++) {
    const ids = paramsForKind(plugin.id, kind) ?? plugin.params.map((param) => param.id)
    const kindName = kinds[kind] ?? plugin.name
    for (const id of ids) {
      if (id === 'kind') {
        rows.push({
          control: `${plugin.name} / ${kindName} / kind`,
          label: 'Kind',
          fn: `Selects ${kinds.join(', ')}`,
          status: 'ok',
          test: TEST,
        })
        continue
      }
      const spec = plugin.params.find((param) => param.id === id)
      if (!spec) continue
      const key = `${plugin.id}:${id}`
      const printed = id === 'mix' || id === 'harmonyMix' || id === 'pAir'
      const status = UNVERIFIED.has(key) ? 'unverified' : FIXED.has(key) || printed ? 'fixed' : 'ok'
      const shown = controlText(plugin.id, id, spec.default, spec.unit)
      rows.push({
        control: `${plugin.name} / ${kindName} / ${id}`,
        label: controlLabel(plugin.id, id, spec.name),
        fn: `${spec.min}–${spec.max}${spec.unit ? ' ' + spec.unit : ''}, default ${shown}`,
        status,
        test: status === 'unverified' ? 'not asserted' : TEST,
      })
    }
  }
}

const mix: Row[] = [
  { control: 'Amp / model', label: 'Amp model', fn: 'Selects the amp voicing.', status: 'ok', test: TEST },
  { control: 'Amp / bright', label: 'Bright', fn: 'High shelf ahead of the amp.', status: 'ok', test: TEST },
  { control: 'Amp / mute', label: 'Mute', fn: 'Silences the amp after the tuner has read the input.', status: 'ok', test: TEST },
  { control: 'Amp / pedal / comp release', label: 'Release', fn: 'Comp pedal release. Was unwired.', status: 'fixed', test: TEST },
  { control: 'Amp / pedal / sub freq', label: 'Freq', fn: 'Sub pedal frequency. Was a fixed 120 Hz.', status: 'fixed', test: TEST },
  { control: 'Amp / cab A', label: 'Cabinet A', fn: 'Cabinet impulse for the left blend.', status: 'unverified', test: 'not asserted' },
  { control: 'Amp / cab B', label: 'Cabinet B', fn: 'Cabinet impulse for the right blend.', status: 'unverified', test: 'not asserted' },
  { control: 'Amp / mic', label: 'Mic', fn: 'Microphone used to build the cabinet impulse.', status: 'unverified', test: 'not asserted' },
  { control: 'Amp / axis', label: 'On axis', fn: 'Moves the mic off the cabinet axis.', status: 'unverified', test: 'not asserted' },
  { control: 'Amp / blend', label: 'Blend', fn: 'Crossfades cabinet A and cabinet B.', status: 'unverified', test: 'not asserted' },
  { control: 'Amp / distance', label: 'Distance', fn: 'Mic distance on the cabinet impulse.', status: 'unverified', test: 'not asserted' },
  { control: 'Mixer / channel / volume', label: 'Volume', fn: 'Linear gain 0–1.25, readout in dB. 0.5 is −6 dB.', status: 'ok', test: TEST },
  { control: 'Mixer / channel / pan', label: 'Pan', fn: 'Constant-power pan, −1 left to +1 right.', status: 'ok', test: TEST },
  { control: 'Mixer / channel / send', label: 'Send level', fn: 'Linear send gain 0–1 onto the bus.', status: 'ok', test: TEST },
  { control: 'Mixer / channel / pre', label: 'Before / After', fn: 'Before ignores the fader. After follows it.', status: 'ok', test: TEST },
  { control: 'Mixer / master / volume', label: 'Master volume', fn: 'Linear gain 0–1.25 on the mix, readout in dB.', status: 'ok', test: TEST },
  { control: 'Plugin / route / wet', label: 'Wet', fn: '0 is the dry insert input. 1 is the processed signal.', status: 'ok', test: TEST },
  { control: 'Transport / tempo', label: 'Tempo', fn: '30–300 BPM. Sets the musical clock and synced delay time.', status: 'ok', test: TEST },
  { control: 'Amp / pedal / tuner level', label: 'Level', fn: 'Tuner pedal does not process audio.', status: 'removed', test: TEST },
  { control: 'Amp / pedal / tuner tone', label: 'Tone', fn: 'Tuner pedal does not process audio.', status: 'removed', test: TEST },
  { control: 'Amp / pedal / octaver tone', label: 'Tone', fn: 'Octave pedal interval is fixed. The extra tone knob did nothing.', status: 'removed', test: TEST },
  { control: 'Amp / pedal / loop tone', label: 'Tone', fn: 'Loop pedal uses Mix, Rec, and Play.', status: 'removed', test: TEST },
]

rows.push(...mix)

const counts = { ok: 0, fixed: 0, removed: 0, unverified: 0 }
for (const row of rows) counts[row.status] += 1

const lines = [
  '# Effect, mixer, and transport controls',
  '',
  'Scope is every effect plugin, the mixer (volume, pan, sends, master), and transport tempo.',
  'Sampler, the library instrument, synths, Beat Machine, Scaler, and Auto-Tune are a separate audit.',
  'Parameter ids are unchanged, so saved presets still load. Stepped knobs print the value the DSP uses.',
  '',
  `Counts: **${counts.ok} ok**, **${counts.fixed} fixed**, **${counts.removed} removed**, **${counts.unverified} unverified**.`,
  '',
  '| Control | Label | Function | Status | Test |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.control} | ${row.label} | ${row.fn.replace(/\|/g, '/')} | ${row.status} | ${row.test} |`),
  '',
]

const out = 'docs/controls-audit-effects.md'
writeFileSync(out, lines.join('\n'))
console.log(out, counts)
