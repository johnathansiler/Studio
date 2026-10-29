import type { Processor } from './types'
import eq from './eq'
import compressor from './compressor'
import deesser from './deesser'
import gate from './gate'
import limiter from './limiter'
import saturator from './saturator'
import doubler from './doubler'
import chorus from './chorus'
import delay from './delay'
import reverb from './reverb'
import tune from './tune'
import pitch from './pitch'
import sampler from './sampler'
import looper from './looper'
import { ampModule } from './amp'
import { moduleFor } from './models'
import { module as mastering } from './mastering'

const MODEL_IDS = ['fet', 'opto', 'bus', 'vari', 'passive', 'pre', 'channel', 'prop', 'focus', 'tape', 'sum', 'plate', 'hall', 'conv', 'echo', 'bbd', 'digital', 'ensemble', 'phase', 'rotor', 'peak']
const MASTER_IDS = ['meq', 'deq', 'mbcomp', 'glue', 'brick', 'maxim', 'mtape', 'image', 'msbox', 'clip', 'dither', 'meter']

const modules: Record<string, { create(sampleRate: number): Processor }> = {
  eq,
  compressor,
  deesser,
  gate,
  limiter,
  saturator,
  doubler,
  chorus,
  delay,
  reverb,
  tune,
  pitch,
  sampler,
  looper,
  amp: ampModule(),
}

for (const id of MODEL_IDS) modules[id] = moduleFor(id)
for (const id of MASTER_IDS) modules[id] = mastering(id)

/** Every insert, created inside the audio thread. The UI still loads plugins one at a time. */
export function createProcessor(id: string, sampleRate: number): Processor | null {
  const mod = modules[id]
  if (!mod) return null
  try {
    return mod.create(sampleRate)
  } catch {
    return null
  }
}
