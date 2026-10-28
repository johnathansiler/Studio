import { controlValues, controlsFor } from './controls'
import type { SampleInstrumentDef, SampleProgramState } from './types'

export function emptyInstrumentDef(name = 'Sample'): SampleInstrumentDef {
  return {
    id: 'sample-empty',
    name,
    zones: [],
    articulations: [],
    mics: [],
    defaultArticulation: '',
    controls: [],
  }
}

export function programFromDef(def: SampleInstrumentDef, revision = 1): SampleProgramState {
  const controls = controlsFor(def)
  return {
    def: { ...def, controls },
    values: controlValues({ ...def, controls }),
    articulation: def.defaultArticulation,
    revision,
  }
}

export function emptySampleProgram(): SampleProgramState {
  return programFromDef(emptyInstrumentDef(), 0)
}
