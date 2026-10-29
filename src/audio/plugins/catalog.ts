import { emptyLooper, emptySampler } from '../sample/engine'
import type { AutomationLane, Insert, PluginInstance, Project, UserPreset } from '../../model/types'
import { AMP_PRESETS } from '../../model/ampPresets'
import { defaultRoll } from '../../model/paint'
import { normalizeQuantize } from '../../model/quantize'
import { defaultRecord, uid } from '../../model/types'
import { normalizeMidiProject } from '../../model/midiTools'
import { normalizeTrackScaler } from '../../instruments/scaler/model'
import { normalizeScale } from '../../model/scale'
import { normalizePadKit } from '../../model/padMachine'
import { bindPatternClips, normalizeBeats, repairArrangementIdentities } from '../../model/steps'
import { normalizeMix } from '../../model/mixGroups'
import { normalizeOmniProject } from '../../instruments/patch/model'
import { tuneLiveLatency } from './autoTune'
import type { FactoryPreset, ParamSpec, PluginDescriptor } from './types'

const VERSION = '1'

function param(id: string, name: string, min: number, max: number, fallback: number, unit: string, automatable = true): ParamSpec {
  return { id, name, min, max, default: fallback, unit, automatable }
}

function ampDescriptor(): PluginDescriptor {
  const params: ParamSpec[] = [
    param('model', 'Amp', 0, 8, 0, '', false),
    param('gain', 'Gain', 0, 1, 0.35, ''),
    param('bass', 'Bass', 0, 1, 0.5, ''),
    param('mid', 'Mid', 0, 1, 0.5, ''),
    param('treble', 'Treble', 0, 1, 0.5, ''),
    param('presence', 'Presence', 0, 1, 0.5, ''),
    param('master', 'Master', 0, 1, 0.65, ''),
    param('bright', 'Bright', 0, 1, 0, '', false),
    param('cab', 'Cab', 0, 1, 1, '', false),
    param('cabA', 'Cab A', 0, 8, 0, '', false),
    param('cabB', 'Cab B', 0, 8, 2, '', false),
    param('blend', 'Blend', 0, 1, 0, ''),
    param('mic', 'Mic', 0, 2, 0, '', false),
    param('axis', 'Axis', 0, 1, 0, '', false),
    param('distance', 'Distance', 0, 1, 0.2, ''),
    param('cal', 'A4', 430, 450, 440, 'Hz', false),
    param('preset', 'Tuning', 0, 6, 1, '', false),
    param('mute', 'Mute', 0, 1, 0, '', false),
    param('expr', 'Expr', 0, 1, 0.3, ''),
    param('loop', 'Loop', 0, 2, 0, '', false),
  ]
  for (let i = 0; i < 8; i++) {
    params.push(param(`s${i}`, `Pedal ${i + 1}`, 0, 23, i === 0 ? 1 : 0, '', false))
    params.push(param(`a${i}`, `Level ${i + 1}`, 0, 1, 0.5, ''))
    params.push(param(`b${i}`, `Tone ${i + 1}`, 0, 1, 0.35, ''))
    params.push(param(`z${i}`, `Place ${i + 1}`, 0, 1, 0, '', false))
  }
  return { id: 'amp', name: 'Amp', version: VERSION, params }
}

export const CATALOG: PluginDescriptor[] = [
  {
    id: 'tune',
    name: 'Auto-Tune',
    version: VERSION,
    params: [
      param('retune', 'Retune', 0.02, 1, 0.95, ''),
      param('humanize', 'Humanize', 0, 1, 0.05, ''),
      param('flex', 'Flex', 0, 1, 0, ''),
      param('amount', 'Amount', 0, 1, 0.85, ''),
      param('transpose', 'Transpose', -12, 12, 0, 'st'),
      param('formant', 'Formant', 0, 1, 0, ''),
      param('mode', 'Mode', 0, 1, 1, ''),
      param('root', 'Root', -1, 11, -1, ''),
      param('scaleIndex', 'Scale', -1, 18, -1, ''),
      param('minHz', 'Low', 50, 400, 80, 'Hz'),
      param('maxHz', 'High', 300, 1600, 1000, 'Hz'),
      param('mask', 'Mask', 0, 4095, 0, '', false),
      param('custom', 'Custom', 0, 1, 0, '', false),
      param('bypassMask', 'Pass', 0, 4095, 0, '', false),
      param('a4', 'A4', 430, 450, 440, 'Hz', false),
      param('hq', 'HQ', 0, 1, 0, '', false),
      param('color', 'Color', 0, 1, 0, '', false),
      param('vibrato', 'Vibrato', 0, 1, 0, ''),
      param('holdMidi', 'Hold', -1, 127, -1, '', false),
      param('n0', 'C', -200, 200, 0, 'ct'),
      param('n1', 'C#', -200, 200, 0, 'ct'),
      param('n2', 'D', -200, 200, 0, 'ct'),
      param('n3', 'D#', -200, 200, 0, 'ct'),
      param('n4', 'E', -200, 200, 0, 'ct'),
      param('n5', 'F', -200, 200, 0, 'ct'),
      param('n6', 'F#', -200, 200, 0, 'ct'),
      param('n7', 'G', -200, 200, 0, 'ct'),
      param('n8', 'G#', -200, 200, 0, 'ct'),
      param('n9', 'A', -200, 200, 0, 'ct'),
      param('n10', 'A#', -200, 200, 0, 'ct'),
      param('n11', 'B', -200, 200, 0, 'ct'),
    ],
  },
  {
    id: 'eq',
    name: 'EQ',
    version: VERSION,
    params: [
      param('hp', 'HP', 20, 1000, 20, 'Hz'),
      param('lp', 'LP', 1000, 20000, 20000, 'Hz'),
      param('lowF', 'Low', 40, 800, 180, 'Hz'),
      param('lowG', 'Low', -18, 12, 0, 'dB'),
      param('lowQ', 'Q', 0.2, 8, 0.7, ''),
      param('midF', 'Mid', 200, 8000, 1500, 'Hz'),
      param('midG', 'Mid', -18, 12, 0, 'dB'),
      param('midQ', 'Q', 0.2, 8, 1, ''),
      param('highF', 'High', 1000, 16000, 8000, 'Hz'),
      param('highG', 'High', -18, 12, 0, 'dB'),
      param('highQ', 'Q', 0.2, 8, 0.7, ''),
    ],
  },
  {
    id: 'compressor',
    name: 'Comp',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -60, 0, 0, 'dB'),
      param('ratio', 'Ratio', 1, 20, 1, ':1'),
      param('attack', 'Attack', 0.1, 80, 10, 'ms'),
      param('release', 'Release', 5, 400, 120, 'ms'),
      param('knee', 'Knee', 0, 24, 0, 'dB'),
      param('makeup', 'Makeup', 0, 24, 0, 'dB'),
      param('mix', 'Mix', 0, 1, 1, ''),
    ],
  },
  {
    id: 'deesser',
    name: 'De-ess',
    version: VERSION,
    params: [
      param('freq', 'Freq', 3000, 12000, 6500, 'Hz'),
      param('threshold', 'Thresh', -50, 0, -18, 'dB'),
      param('amount', 'Amount', 0, 1, 0, ''),
    ],
  },
  {
    id: 'gate',
    name: 'Gate',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -80, 0, -80, 'dB'),
      param('ratio', 'Ratio', 1, 20, 1, ':1'),
      param('attack', 'Attack', 0.1, 40, 5, 'ms'),
      param('release', 'Release', 5, 400, 80, 'ms'),
      param('hold', 'Hold', 0, 200, 20, 'ms'),
      param('range', 'Range', 0, 80, 40, 'dB'),
    ],
  },
  {
    id: 'limiter',
    name: 'Limiter',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -24, 0, 0, 'dB'),
      param('release', 'Release', 5, 200, 50, 'ms'),
      param('ceiling', 'Ceiling', -3, 0, -0.1, 'dB'),
    ],
  },
  {
    id: 'saturator',
    name: 'Sat',
    version: VERSION,
    params: [
      param('drive', 'Drive', 0, 1, 0, ''),
      param('tone', 'Tone', 800, 12000, 8000, 'Hz'),
      param('mix', 'Mix', 0, 1, 1, ''),
    ],
  },
  {
    id: 'doubler',
    name: 'Double',
    version: VERSION,
    params: [
      param('width', 'Width', 0, 1, 0.5, ''),
      param('delay', 'Delay', 5, 40, 18, 'ms'),
      param('depth', 'Depth', 0, 1, 0.3, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'chorus',
    name: 'Chorus',
    version: VERSION,
    params: [
      param('rate', 'Rate', 0.05, 4, 0.4, 'Hz'),
      param('depth', 'Depth', 0, 1, 0.4, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'delay',
    name: 'Delay',
    version: VERSION,
    params: [
      param('sync', 'Sync', 0, 1, 1, ''),
      param('division', 'Div', 0.125, 1, 0.375, 'beat'),
      param('time', 'Time', 1, 1000, 250, 'ms'),
      param('feedback', 'Feedback', 0, 0.9, 0.35, ''),
      param('pingpong', 'Ping', 0, 1, 1, ''),
      param('filter', 'Filter', 400, 12000, 5000, 'Hz'),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'reverb',
    name: 'Reverb',
    version: VERSION,
    params: [
      param('mode', 'Mode', 0, 2, 2, ''),
      param('size', 'Size', 0.1, 1, 0.6, ''),
      param('damp', 'Damp', 0, 1, 0.4, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'pitch',
    name: 'Pitch',
    version: VERSION,
    params: [
      param('semis', 'Semi', -12, 12, 0, 'st'),
      param('harmony', 'Harm', -12, 12, 7, 'st'),
      param('harmonyMix', 'Harm', 0, 1, 0, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  ampDescriptor(),
  {
    id: 'fet',
    name: 'FET',
    version: VERSION,
    params: [
      param('input', 'Input', -24, 24, 0, 'dB'),
      param('output', 'Output', -24, 24, 0, 'dB'),
      param('ratio', 'Ratio', 0, 4, 0, ''),
      param('attack', 'Attack', 0.02, 0.8, 0.2, 'ms'),
      param('release', 'Release', 50, 1100, 300, 'ms'),
    ],
  },
  {
    id: 'opto',
    name: 'Opto',
    version: VERSION,
    params: [
      param('peak', 'Peak', 0, 1, 0.35, ''),
      param('gain', 'Gain', 0, 24, 6, 'dB'),
    ],
  },
  {
    id: 'bus',
    name: 'Bus',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -40, 0, -8, 'dB'),
      param('ratio', 'Ratio', 0, 2, 1, ''),
      param('attack', 'Attack', 0, 5, 2, ''),
      param('release', 'Release', 0, 4, 4, ''),
      param('hpf', 'SC HPF', 20, 300, 80, 'Hz'),
      param('makeup', 'Makeup', 0, 18, 0, 'dB'),
    ],
  },
  {
    id: 'vari',
    name: 'Vari',
    version: VERSION,
    params: [
      param('time', 'Time', 0, 5, 1, ''),
      param('input', 'Input', -12, 24, 0, 'dB'),
      param('output', 'Output', -12, 12, 0, 'dB'),
      param('color', 'Color', 0, 1, 0.35, ''),
    ],
  },
  {
    id: 'passive',
    name: 'Passive',
    version: VERSION,
    params: [
      param('lowF', 'Low', 0, 3, 2, ''),
      param('lowBoost', 'Boost', 0, 1, 0, ''),
      param('lowAtten', 'Atten', 0, 1, 0, ''),
      param('highF', 'High', 0, 6, 4, ''),
      param('highBoost', 'HF', 0, 1, 0, ''),
      param('highBw', 'Width', 0, 1, 0.5, ''),
      param('highAtten', 'HF cut', 0, 1, 0, ''),
      param('highAttenF', 'Cut', 0, 2, 1, ''),
    ],
  },
  {
    id: 'pre',
    name: 'Pre',
    version: VERSION,
    params: [
      param('hp', 'HP', 0, 4, 0, ''),
      param('lowF', 'Low', 0, 3, 2, ''),
      param('lowG', 'Low', -16, 16, 0, 'dB'),
      param('midF', 'Mid', 0, 5, 2, ''),
      param('midG', 'Mid', -18, 18, 0, 'dB'),
      param('highF', 'High', 0, 1, 0, ''),
      param('highG', 'High', -16, 16, 0, 'dB'),
      param('drive', 'Drive', 0, 1, 0, ''),
    ],
  },
  {
    id: 'channel',
    name: 'Channel',
    version: VERSION,
    params: [
      param('curve', 'Curve', 0, 1, 0, ''),
      param('lfF', 'LF', 0, 3, 1, ''),
      param('lfG', 'LF', -15, 15, 0, 'dB'),
      param('lmfF', 'LMF', 0, 3, 1, ''),
      param('lmfG', 'LMF', -15, 15, 0, 'dB'),
      param('hmfF', 'HMF', 0, 3, 2, ''),
      param('hmfG', 'HMF', -15, 15, 0, 'dB'),
      param('hfF', 'HF', 0, 3, 2, ''),
      param('hfG', 'HF', -15, 15, 0, 'dB'),
    ],
  },
  {
    id: 'prop',
    name: 'Prop',
    version: VERSION,
    params: [
      param('freq', 'Freq', 0, 10, 5, ''),
      param('gain', 'Gain', -12, 12, 0, 'dB'),
    ],
  },
  {
    id: 'focus',
    name: 'Focus',
    version: VERSION,
    params: [
      param('f0', 'Low', 40, 500, 120, 'Hz'),
      param('g0', 'Low', -18, 18, 0, 'dB'),
      param('q0', 'Q', 0.2, 12, 0.7, ''),
      param('f1', 'Mid', 200, 8000, 1500, 'Hz'),
      param('g1', 'Mid', -18, 18, 0, 'dB'),
      param('q1', 'Q', 0.2, 12, 1, ''),
      param('f2', 'High', 1000, 16000, 8000, 'Hz'),
      param('g2', 'High', -18, 18, 0, 'dB'),
      param('q2', 'Q', 0.2, 12, 0.7, ''),
      param('dynamic', 'Dynamic', 0, 1, 0, ''),
      param('threshold', 'Thresh', -48, 0, -18, 'dB'),
      param('linear', 'Linear', 0, 1, 0, ''),
      param('ms', 'M/S', 0, 2, 0, ''),
    ],
  },
  {
    id: 'tape',
    name: 'Tape',
    version: VERSION,
    params: [
      param('speed', 'Speed', 0, 2, 1, ''),
      param('bias', 'Bias', 0, 1, 0.4, ''),
      param('wow', 'Wow', 0, 1, 0.15, ''),
      param('bump', 'Bump', 0, 1, 0.4, ''),
      param('hiss', 'Hiss', 0, 1, 0.1, ''),
      param('drive', 'Drive', 0, 1, 0.3, ''),
    ],
  },
  {
    id: 'sum',
    name: 'Sum',
    version: VERSION,
    params: [
      param('drive', 'Drive', 0, 1, 0.25, ''),
      param('tube', 'Tube', 0, 1, 0, ''),
    ],
  },
  {
    id: 'plate',
    name: 'Plate',
    version: VERSION,
    params: [
      param('size', 'Size', 0.15, 1, 0.5, ''),
      param('decay', 'Decay', 0.2, 0.95, 0.7, ''),
      param('damp', 'Damp', 0, 0.9, 0.35, ''),
      param('mix', 'Mix', 0, 1, 0.22, ''),
    ],
  },
  {
    id: 'hall',
    name: 'Hall',
    version: VERSION,
    params: [
      param('mode', 'Mode', 0, 2, 1, ''),
      param('size', 'Size', 0.15, 1, 0.7, ''),
      param('decay', 'Decay', 0.2, 0.96, 0.8, ''),
      param('damp', 'Damp', 0, 0.9, 0.4, ''),
      param('mix', 'Mix', 0, 1, 0.24, ''),
    ],
  },
  {
    id: 'conv',
    name: 'Conv',
    version: VERSION,
    params: [
      param('ir', 'IR', 0, 1, 0, ''),
      param('mix', 'Mix', 0, 1, 0.3, ''),
    ],
  },
  {
    id: 'echo',
    name: 'Echo',
    version: VERSION,
    params: [
      param('time', 'Time', 20, 1000, 280, 'ms'),
      param('feedback', 'Feedback', 0, 0.9, 0.35, ''),
      param('wow', 'Wow', 0, 1, 0.25, ''),
      param('drive', 'Drive', 0, 1, 0.3, ''),
      param('mix', 'Mix', 0, 1, 0.3, ''),
    ],
  },
  {
    id: 'bbd',
    name: 'BBD',
    version: VERSION,
    params: [
      param('time', 'Time', 10, 380, 180, 'ms'),
      param('feedback', 'Feedback', 0, 0.85, 0.3, ''),
      param('clock', 'Clock', 0, 1, 0.45, ''),
      param('mix', 'Mix', 0, 1, 0.3, ''),
    ],
  },
  {
    id: 'digital',
    name: 'Digital',
    version: VERSION,
    params: [
      param('time', 'Time', 1, 1800, 250, 'ms'),
      param('feedback', 'Feedback', 0, 0.95, 0.25, ''),
      param('mix', 'Mix', 0, 1, 0.3, ''),
    ],
  },
  {
    id: 'ensemble',
    name: 'Ensemble',
    version: VERSION,
    params: [
      param('rate', 'Rate', 0.05, 4, 0.4, 'Hz'),
      param('depth', 'Depth', 0, 1, 0.4, ''),
      param('mode', 'Mode', 0, 1, 0, ''),
      param('mix', 'Mix', 0, 1, 0.4, ''),
    ],
  },
  {
    id: 'phase',
    name: 'Phase',
    version: VERSION,
    params: [
      param('rate', 'Rate', 0.02, 4, 0.3, 'Hz'),
      param('depth', 'Depth', 0, 1, 0.6, ''),
      param('feedback', 'Feedback', 0, 0.9, 0.4, ''),
      param('mix', 'Mix', 0, 1, 0.5, ''),
    ],
  },
  {
    id: 'rotor',
    name: 'Rotor',
    version: VERSION,
    params: [
      param('speed', 'Speed', 0, 1, 0, ''),
      param('mix', 'Mix', 0, 1, 0.7, ''),
    ],
  },
  {
    id: 'peak',
    name: 'Peak',
    version: VERSION,
    params: [
      param('ceiling', 'Ceiling', -6, 0, -1, 'dB'),
      param('release', 'Release', 10, 500, 80, 'ms'),
    ],
  },
  {
    id: 'scaler',
    name: 'Scaler',
    version: VERSION,
    params: [],
  },
  {
    id: 'pads',
    name: 'Pads',
    version: VERSION,
    params: [],
  },
  {
    id: 'sampler',
    name: 'Sampler',
    version: VERSION,
    params: [
      param('gain', 'Gain', 0, 1, 0.8, ''),
      param('pitch', 'Pitch', -24, 24, 0, 'st'),
      param('pan', 'Pan', -1, 1, 0, ''),
      param('attack', 'Attack', 1, 2000, 4, 'ms'),
      param('decay', 'Decay', 5, 3000, 200, 'ms'),
      param('sustain', 'Sustain', 0, 1, 0.8, ''),
      param('release', 'Release', 5, 4000, 180, 'ms'),
      param('cutoff', 'Cutoff', 80, 16000, 16000, 'Hz'),
      param('res', 'Res', 0, 0.9, 0, ''),
      param('stretch', 'Stretch', 0, 1, 1, ''),
      param('keys', 'Keys', 0, 1, 0, ''),
      param('mono', 'Mono', 0, 1, 0, ''),
      param('record', 'Rec', 0, 1, 0, ''),
      param('loopMode', 'Loop', 0, 2, 0, ''),
      param('crossfade', 'Fade', 0, 0.5, 0.02, ''),
      param('sensitivity', 'Sense', 0, 1, 0.45, ''),
    ],
  },
  {
    id: 'looper',
    name: 'Looper',
    version: VERSION,
    params: [
      param('transport', 'Play', 0, 3, 0, ''),
      param('bars', 'Bars', 1, 8, 1, ''),
      param('sync', 'Sync', 0, 1, 1, ''),
      param('feedback', 'Decay', 0, 1, 0.85, ''),
      param('level', 'Level', 0, 1, 0.9, ''),
      param('speed', 'Speed', 0.5, 2, 1, ''),
      param('reverse', 'Reverse', 0, 1, 0, ''),
    ],
  },
  {
    id: 'meq',
    name: 'Lin EQ',
    version: VERSION,
    params: [
      param('phase', 'Phase', 0, 1, 1, ''),
      param('ms', 'M/S', 0, 1, 0, ''),
      param('hp', 'HP', 20, 200, 30, 'Hz'),
      param('lp', 'LP', 8000, 20000, 19000, 'Hz'),
      param('lowG', 'Low', -12, 12, 0, 'dB'),
      param('midF', 'Mid', 200, 8000, 1400, 'Hz'),
      param('midG', 'Mid', -12, 12, 0, 'dB'),
      param('midQ', 'Q', 0.3, 6, 1, ''),
      param('highG', 'High', -12, 12, 0, 'dB'),
      param('sLow', 'S Low', -12, 12, 0, 'dB'),
      param('sMid', 'S Mid', -12, 12, 0, 'dB'),
      param('sHigh', 'S High', -12, 12, 0, 'dB'),
    ],
  },
  {
    id: 'deq',
    name: 'Dyn EQ',
    version: VERSION,
    params: [
      param('freq', 'Freq', 80, 12000, 3000, 'Hz'),
      param('q', 'Q', 0.4, 6, 1.2, ''),
      param('threshold', 'Thresh', -48, 0, -24, 'dB'),
      param('gain', 'Gain', -12, 12, 0, 'dB'),
      param('attack', 'Attack', 1, 40, 10, 'ms'),
      param('release', 'Release', 10, 300, 80, 'ms'),
    ],
  },
  {
    id: 'mbcomp',
    name: 'Multi',
    version: VERSION,
    params: [
      param('bands', 'Bands', 3, 5, 4, ''),
      param('x1', 'X1', 40, 400, 120, 'Hz'),
      param('x2', 'X2', 150, 1500, 500, 'Hz'),
      param('x3', 'X3', 800, 6000, 2000, 'Hz'),
      param('x4', 'X4', 2000, 12000, 6000, 'Hz'),
      param('threshold', 'Thresh', -40, 0, -18, 'dB'),
      param('ratio', 'Ratio', 1, 12, 2, ':1'),
      param('attack', 'Attack', 1, 40, 10, 'ms'),
      param('release', 'Release', 10, 300, 80, 'ms'),
      param('makeup', 'Makeup', 0, 12, 0, 'dB'),
      param('ms', 'M/S', 0, 1, 0, ''),
    ],
  },
  {
    id: 'glue',
    name: 'Glue',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -30, 0, -12, 'dB'),
      param('ratio', 'Ratio', 1, 10, 2, ':1'),
      param('attack', 'Attack', 0.1, 30, 10, 'ms'),
      param('release', 'Release', 20, 400, 120, 'ms'),
      param('releaseMode', 'Rel', 0, 2, 1, ''),
      param('makeup', 'Makeup', 0, 12, 0, 'dB'),
      param('mix', 'Mix', 0, 1, 1, ''),
    ],
  },
  {
    id: 'brick',
    name: 'Brick',
    version: VERSION,
    params: [
      param('ceiling', 'Ceiling', -6, 0, -1, 'dB'),
      param('release', 'Release', 20, 300, 80, 'ms'),
      param('lookahead', 'Look', 1, 10, 5, 'ms'),
      param('releaseMode', 'Rel', 0, 2, 1, ''),
    ],
  },
  {
    id: 'maxim',
    name: 'Max',
    version: VERSION,
    params: [
      param('target', 'Target', -24, -6, -14, 'LU'),
      param('ceiling', 'Ceiling', -3, 0, -1, 'dB'),
    ],
  },
  {
    id: 'mtape',
    name: 'M-Tape',
    version: VERSION,
    params: [
      param('drive', 'Drive', 0, 1, 0.25, ''),
      param('color', 'Color', 0, 1, 0, ''),
      param('mix', 'Mix', 0, 1, 0.6, ''),
    ],
  },
  {
    id: 'image',
    name: 'Image',
    version: VERSION,
    params: [
      param('width', 'Width', 0, 2, 1, ''),
      param('bass', 'Mono', 40, 300, 120, 'Hz'),
      param('low', 'Low', 0, 2, 1, ''),
      param('high', 'High', 0, 2, 1, ''),
    ],
  },
  {
    id: 'msbox',
    name: 'M/S',
    version: VERSION,
    params: [
      param('mid', 'Mid', -12, 12, 0, 'dB'),
      param('side', 'Side', -24, 12, 0, 'dB'),
    ],
  },
  {
    id: 'clip',
    name: 'Clip',
    version: VERSION,
    params: [
      param('drive', 'Drive', 0, 1, 0.2, ''),
      param('mode', 'Mode', 0, 1, 0, ''),
      param('ceiling', 'Ceiling', -6, 0, -0.3, 'dB'),
    ],
  },
  {
    id: 'dither',
    name: 'Dither',
    version: VERSION,
    params: [
      param('bits', 'Bits', 16, 24, 24, ''),
      param('shape', 'Shape', 0, 2, 1, ''),
    ],
  },
  {
    id: 'meter',
    name: 'Meter',
    version: VERSION,
    params: [],
  },
]

export const FACTORY: Record<string, FactoryPreset[]> = {
  eq: [
    { name: 'Flat', params: {} },
    { name: 'Vocal', params: { hp: 90, lowF: 250, lowG: -1.5, midF: 3200, midG: 2.5, midQ: 1.1, highF: 10000, highG: 1.5, lp: 18000 } },
    { name: 'Air', params: { highF: 12000, highG: 3, hp: 70 } },
    { name: 'Low cut', params: { hp: 120, lowG: -2, lowF: 200 } },
  ],
  compressor: [
    { name: 'Gentle', params: { threshold: -12, ratio: 2, attack: 15, release: 140, knee: 8, makeup: 1, mix: 1 } },
    { name: 'Vocal', params: { threshold: -18, ratio: 3, attack: 8, release: 120, knee: 6, makeup: 3, mix: 1 } },
    { name: 'Squeeze', params: { threshold: -24, ratio: 6, attack: 5, release: 80, knee: 4, makeup: 6, mix: 1 } },
    { name: 'Duck', params: { threshold: -30, ratio: 10, attack: 1, release: 160, knee: 6, makeup: 0, mix: 1 } },
  ],
  deesser: [
    { name: 'Vocal', params: { freq: 6800, threshold: -22, amount: 0.55 } },
    { name: 'Hard', params: { freq: 6000, threshold: -28, amount: 0.85 } },
  ],
  gate: [
    { name: 'Vocal', params: { threshold: -42, ratio: 8, attack: 3, release: 90, hold: 25, range: 36 } },
    { name: 'Tight', params: { threshold: -36, ratio: 14, attack: 1, release: 50, hold: 10, range: 60 } },
  ],
  limiter: [
    { name: 'Transparent', params: { threshold: 0, release: 40, ceiling: -0.1 } },
    { name: 'Safe', params: { threshold: -6, release: 80, ceiling: -1 } },
  ],
  saturator: [
    { name: 'Tape', params: { drive: 0.35, tone: 7000, mix: 0.5 } },
    { name: 'Warm', params: { drive: 0.2, tone: 5000, mix: 0.7 } },
  ],
  doubler: [
    { name: 'Wide', params: { width: 0.8, delay: 22, depth: 0.4, mix: 0.45 } },
    { name: 'Tight', params: { width: 0.35, delay: 12, depth: 0.2, mix: 0.4 } },
  ],
  chorus: [
    { name: 'Soft', params: { rate: 0.3, depth: 0.35, mix: 0.3 } },
    { name: 'Wide', params: { rate: 0.6, depth: 0.7, mix: 0.45 } },
  ],
  delay: [
    { name: 'Quarter', params: { sync: 1, division: 1, feedback: 0.3, pingpong: 0, filter: 6000, mix: 0.28 } },
    { name: 'Dotted', params: { sync: 1, division: 0.75, feedback: 0.38, pingpong: 1, filter: 4500, mix: 0.3 } },
    { name: 'Ping-pong', params: { sync: 1, division: 0.375, feedback: 0.42, pingpong: 1, filter: 4000, mix: 0.32 } },
  ],
  reverb: [
    { name: 'Plate', params: { mode: 0, size: 0.45, damp: 0.35, mix: 0.22 } },
    { name: 'Room', params: { mode: 1, size: 0.35, damp: 0.5, mix: 0.18 } },
    { name: 'Hall', params: { mode: 2, size: 0.75, damp: 0.4, mix: 0.24 } },
  ],
  tune: [
    { name: 'Hard tune/T-Pain', params: { retune: 0.95, humanize: 0.05, flex: 0, amount: 0.85, mode: 1, minHz: 80, maxHz: 1000, transpose: 0, formant: 0.15, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Natural', params: { retune: 0.42, humanize: 0.55, flex: 0.35, amount: 0.72, mode: 1, minHz: 80, maxHz: 900, transpose: 0, formant: 0, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Soprano', params: { retune: 0.75, humanize: 0.2, amount: 0.85, mode: 1, minHz: 200, maxHz: 1200, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Alto/Tenor', params: { retune: 0.6, humanize: 0.35, amount: 0.8, mode: 1, minHz: 120, maxHz: 700, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Low male', params: { retune: 0.5, humanize: 0.4, amount: 0.75, mode: 1, minHz: 70, maxHz: 420, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Instrument', params: { retune: 0.9, humanize: 0.1, amount: 0.9, mode: 0, minHz: 50, maxHz: 1500, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
  ],
  pitch: [
    { name: 'Octave up', params: { semis: 12, harmony: 7, harmonyMix: 0, mix: 1 } },
    { name: 'Fifth', params: { semis: 0, harmony: 7, harmonyMix: 0.6, mix: 0.8 } },
    { name: 'Double', params: { semis: 0.1, harmony: 12, harmonyMix: 0.35, mix: 0.5 } },
  ],
  amp: AMP_PRESETS,
  fet: [
    { name: 'Vocal', params: { input: 8, output: -2, ratio: 0, attack: 0.4, release: 250 } },
    { name: 'Drums', params: { input: 14, output: -4, ratio: 3, attack: 0.08, release: 120 } },
    { name: 'Bus', params: { input: 4, output: 0, ratio: 1, attack: 0.5, release: 400 } },
    { name: 'Crush', params: { input: 16, output: -6, ratio: 4, attack: 0.05, release: 80 } },
  ],
  opto: [
    { name: 'Vocal', params: { peak: 0.45, gain: 8 } },
    { name: 'Bass', params: { peak: 0.6, gain: 6 } },
    { name: 'Bus', params: { peak: 0.25, gain: 3 } },
    { name: 'Master', params: { peak: 0.15, gain: 2 } },
  ],
  bus: [
    { name: 'Vocal', params: { threshold: -16, ratio: 1, attack: 2, release: 2, hpf: 90, makeup: 2 } },
    { name: 'Drums', params: { threshold: -12, ratio: 1, attack: 1, release: 4, hpf: 80, makeup: 3 } },
    { name: 'Bus', params: { threshold: -8, ratio: 0, attack: 2, release: 4, hpf: 70, makeup: 1 } },
    { name: 'Master', params: { threshold: -6, ratio: 0, attack: 3, release: 4, hpf: 40, makeup: 1 } },
  ],
  vari: [
    { name: 'Vocal', params: { time: 1, input: 4, output: 0, color: 0.4 } },
    { name: 'Drums', params: { time: 0, input: 6, output: -1, color: 0.25 } },
    { name: 'Bus', params: { time: 2, input: 2, output: 0, color: 0.3 } },
    { name: 'Master', params: { time: 4, input: 1, output: 0, color: 0.2 } },
  ],
  passive: [
    { name: 'Vocal', params: { lowF: 2, lowBoost: 0.25, lowAtten: 0.2, highF: 4, highBoost: 0.35, highBw: 0.4, highAtten: 0 } },
    { name: 'Drums', params: { lowF: 1, lowBoost: 0.4, lowAtten: 0.15, highF: 5, highBoost: 0.2, highBw: 0.6 } },
    { name: 'Bus', params: { lowF: 2, lowBoost: 0.15, lowAtten: 0.1, highBoost: 0.2, highBw: 0.5 } },
    { name: 'Air', params: { highF: 6, highBoost: 0.45, highBw: 0.3, lowBoost: 0 } },
  ],
  pre: [
    { name: 'Vocal', params: { hp: 2, lowF: 2, lowG: -2, midF: 3, midG: 2, highF: 1, highG: 2, drive: 0.2 } },
    { name: 'Drums', params: { hp: 1, lowF: 1, lowG: 3, midF: 2, midG: -1, drive: 0.35 } },
    { name: 'Bus', params: { lowG: 1, highG: 1, drive: 0.15 } },
    { name: 'Master', params: { highF: 0, highG: 1, drive: 0.1 } },
  ],
  channel: [
    { name: 'Vocal', params: { curve: 0, lfG: -2, lmfG: 2, hmfF: 2, hmfG: 1.5, hfG: 2 } },
    { name: 'Drums', params: { curve: 1, lfG: 2, lmfG: -1, hmfG: 2, hfG: 1 } },
    { name: 'Bus', params: { curve: 0, lfG: 1, hfG: 1 } },
    { name: 'Master', params: { curve: 0, hfG: 0.8, lfG: 0.5 } },
  ],
  prop: [
    { name: 'Vocal', params: { freq: 7, gain: 3 } },
    { name: 'Drums', params: { freq: 2, gain: 4 } },
    { name: 'Bus', params: { freq: 4, gain: -2 } },
    { name: 'Master', params: { freq: 9, gain: 1.5 } },
  ],
  focus: [
    { name: 'Vocal', params: { f0: 90, g0: -2, f1: 3200, g1: 2, q1: 1, f2: 11000, g2: 1.5, dynamic: 0.2, ms: 0 } },
    { name: 'Drums', params: { f0: 60, g0: 2, f1: 400, g1: -2, f2: 8000, g2: 1 } },
    { name: 'Bus', params: { f0: 40, g0: 0.5, f2: 12000, g2: 1, linear: 0 } },
    { name: 'Master', params: { f2: 14000, g2: 0.8, q2: 0.5, linear: 1, dynamic: 0 } },
  ],
  tape: [
    { name: 'Vocal', params: { speed: 1, bias: 0.35, wow: 0.08, bump: 0.3, hiss: 0.05, drive: 0.25 } },
    { name: 'Drums', params: { speed: 2, bias: 0.5, wow: 0.05, bump: 0.5, drive: 0.45 } },
    { name: 'Bus', params: { speed: 1, bias: 0.4, wow: 0.1, bump: 0.35, drive: 0.3 } },
    { name: 'Master', params: { speed: 2, bias: 0.25, wow: 0.04, bump: 0.2, hiss: 0.02, drive: 0.15 } },
  ],
  sum: [
    { name: 'Vocal', params: { drive: 0.2, tube: 1 } },
    { name: 'Drums', params: { drive: 0.4, tube: 0 } },
    { name: 'Bus', params: { drive: 0.3, tube: 0 } },
    { name: 'Master', params: { drive: 0.12, tube: 1 } },
  ],
  plate: [
    { name: 'Vocal', params: { size: 0.45, decay: 0.68, damp: 0.3, mix: 0.2 } },
    { name: 'Drums', params: { size: 0.35, decay: 0.5, damp: 0.45, mix: 0.16 } },
    { name: 'Bus', params: { size: 0.55, decay: 0.75, damp: 0.4, mix: 0.18 } },
  ],
  hall: [
    { name: 'Vocal', params: { mode: 2, size: 0.5, decay: 0.7, damp: 0.4, mix: 0.2 } },
    { name: 'Drums', params: { mode: 0, size: 0.4, decay: 0.45, damp: 0.5, mix: 0.14 } },
    { name: 'Hall', params: { mode: 1, size: 0.8, decay: 0.88, damp: 0.35, mix: 0.24 } },
    { name: 'Master', params: { mode: 1, size: 0.6, decay: 0.6, damp: 0.5, mix: 0.08 } },
  ],
  conv: [
    { name: 'Room', params: { ir: 0, mix: 0.25 } },
    { name: 'Plate', params: { ir: 1, mix: 0.22 } },
  ],
  echo: [
    { name: 'Vocal', params: { time: 320, feedback: 0.28, wow: 0.3, drive: 0.35, mix: 0.22 } },
    { name: 'Drums', params: { time: 180, feedback: 0.2, wow: 0.1, drive: 0.4, mix: 0.18 } },
    { name: 'Slap', params: { time: 90, feedback: 0.1, wow: 0.15, drive: 0.2, mix: 0.25 } },
  ],
  bbd: [
    { name: 'Vocal', params: { time: 220, feedback: 0.3, clock: 0.4, mix: 0.22 } },
    { name: 'Drums', params: { time: 120, feedback: 0.2, clock: 0.6, mix: 0.16 } },
    { name: 'Dark', params: { time: 300, feedback: 0.4, clock: 0.8, mix: 0.28 } },
  ],
  digital: [
    { name: 'Vocal', params: { time: 375, feedback: 0.25, mix: 0.2 } },
    { name: 'Drums', params: { time: 125, feedback: 0.15, mix: 0.16 } },
    { name: 'Bus', params: { time: 250, feedback: 0.3, mix: 0.18 } },
  ],
  ensemble: [
    { name: 'Vocal', params: { rate: 0.35, depth: 0.3, mode: 0, mix: 0.28 } },
    { name: 'Wide', params: { rate: 0.2, depth: 0.45, mode: 1, mix: 0.4 } },
    { name: 'Drums', params: { rate: 0.5, depth: 0.2, mode: 0, mix: 0.15 } },
  ],
  phase: [
    { name: 'Vocal', params: { rate: 0.2, depth: 0.5, feedback: 0.3, mix: 0.35 } },
    { name: 'Drums', params: { rate: 0.8, depth: 0.7, feedback: 0.5, mix: 0.3 } },
    { name: 'Slow', params: { rate: 0.08, depth: 0.6, feedback: 0.45, mix: 0.4 } },
  ],
  rotor: [
    { name: 'Slow', params: { speed: 0, mix: 0.7 } },
    { name: 'Fast', params: { speed: 1, mix: 0.75 } },
    { name: 'Vocal', params: { speed: 0, mix: 0.4 } },
  ],
  peak: [
    { name: 'Master', params: { ceiling: -1, release: 80 } },
    { name: 'Vocal', params: { ceiling: -1.5, release: 40 } },
    { name: 'Drums', params: { ceiling: -0.8, release: 30 } },
    { name: 'Safe', params: { ceiling: -1.5, release: 120 } },
  ],
  sampler: [
    { name: 'Loop', params: { stretch: 1, keys: 0, loopMode: 0, crossfade: 0.04 } },
    { name: 'One shot', params: { stretch: 0, loopMode: 2, attack: 1, sustain: 1, release: 40 } },
    { name: 'Keys', params: { keys: 1, stretch: 0, loopMode: 0, attack: 6, sustain: 0.85 } },
  ],
  looper: [
    { name: '1 bar', params: { sync: 1, bars: 1, feedback: 0.9, transport: 0 } },
    { name: '4 bars', params: { sync: 1, bars: 4, feedback: 0.85 } },
    { name: 'Free', params: { sync: 0, bars: 1, feedback: 1 } },
  ],
  meq: [
    { name: 'Flat', params: { phase: 1, lowG: 0, midG: 0, highG: 0 } },
    { name: 'Air', params: { phase: 1, highG: 2, hp: 30 } },
    { name: 'Warm', params: { phase: 0, lowG: 1.5, highG: -0.5 } },
  ],
  deq: [
    { name: 'Harsh', params: { freq: 3500, threshold: -20, gain: -3, q: 1.4 } },
    { name: 'Mud', params: { freq: 250, threshold: -18, gain: -2.5, q: 0.8 } },
  ],
  mbcomp: [
    { name: 'Gentle', params: { bands: 4, threshold: -16, ratio: 1.8, ms: 0 } },
    { name: 'Wide', params: { bands: 4, threshold: -18, ratio: 2, ms: 1 } },
  ],
  glue: [
    { name: 'SSL', params: { threshold: -8, ratio: 4, attack: 10, release: 100, releaseMode: 1, makeup: 2, mix: 1 } },
    { name: 'Soft', params: { threshold: -14, ratio: 2, attack: 30, release: 200, releaseMode: 2, mix: 0.7 } },
  ],
  brick: [
    { name: 'Stream', params: { ceiling: -1, release: 80, lookahead: 5, releaseMode: 1 } },
    { name: 'CD', params: { ceiling: -0.1, release: 50, lookahead: 5, releaseMode: 0 } },
  ],
  maxim: [
    { name: 'Spotify', params: { target: -14, ceiling: -1 } },
    { name: 'Club', params: { target: -6, ceiling: -0.3 } },
  ],
  mtape: [
    { name: 'Tape', params: { drive: 0.3, color: 0, mix: 0.6 } },
    { name: 'Tube', params: { drive: 0.35, color: 1, mix: 0.5 } },
  ],
  image: [
    { name: 'Widen', params: { width: 1.3, bass: 120, low: 0.8, high: 1.3 } },
    { name: 'Mono bass', params: { width: 1, bass: 150, low: 0.7, high: 1.1 } },
  ],
  msbox: [
    { name: 'Sides', params: { mid: 0, side: 2 } },
    { name: 'Center', params: { mid: 1, side: -3 } },
  ],
  clip: [
    { name: 'Soft', params: { drive: 0.3, mode: 0, ceiling: -0.3 } },
    { name: 'Hard', params: { drive: 0.4, mode: 1, ceiling: -0.3 } },
  ],
  dither: [
    { name: '24-bit', params: { bits: 24, shape: 1 } },
    { name: '16-bit', params: { bits: 16, shape: 2 } },
  ],
  meter: [{ name: 'Meter', params: {} }],
}

export function descriptor(id: string) {
  return CATALOG.find((plugin) => plugin.id === id) ?? null
}

export function defaultParams(id: string) {
  const spec = descriptor(id)
  const params: Record<string, number> = {}
  if (!spec) return params
  for (const item of spec.params) params[item.id] = item.default
  return params
}

export function createPlugin(pluginId: string, preset?: string): PluginInstance {
  const params = defaultParams(pluginId)
  const chosen = (FACTORY[pluginId] ?? []).find((item) => item.name === preset)
  if (chosen) Object.assign(params, chosen.params)
  return {
    id: uid('fx'),
    pluginId,
    version: descriptor(pluginId)?.version ?? VERSION,
    enabled: true,
    wet: 1,
    params,
    sidechain: '',
    sampler: pluginId === 'sampler' ? emptySampler() : undefined,
    looper: pluginId === 'looper' ? emptyLooper() : undefined,
  }
}

export function latencyOf(pluginId: string, params: Record<string, number>, sampleRate: number, enabled = true, live = false) {
  if (!enabled) return 0
  if (pluginId === 'tune' && (params.amount ?? 0) > 0.001) {
    if (live && (params.hq ?? 0) < 0.5) return tuneLiveLatency(sampleRate)
    return tuneLatency(sampleRate)
  }
  if (pluginId === 'pitch' && (params.mix ?? 0) > 0.001) return tuneLatency(sampleRate)
  if (pluginId === 'limiter') return 64
  if (pluginId === 'peak') return 96
  if (pluginId === 'focus' && (params.linear ?? 0) >= 0.5) return 256
  if (pluginId === 'brick' || pluginId === 'maxim') return Math.round(((params.lookahead || 5) / 1000) * sampleRate)
  return 0
}

function fillInstrument(plugin: PluginInstance): PluginInstance {
  if (plugin.pluginId === 'sampler' && !plugin.sampler) plugin.sampler = emptySampler()
  if (plugin.pluginId === 'looper' && !plugin.looper) plugin.looper = emptyLooper()
  return plugin
}

export function tuneLatency(sampleRate: number) {
  const span = Math.max(1024, Math.round(1536 * (sampleRate / 48000)))
  return span + Math.floor(span / 2)
}

export function normalizeProject(project: Project): Project {
  normalizeMidiProject(project)
  normalizeOmniProject(project)
  project.scale = normalizeScale(project.scale)
  project.padKit = normalizePadKit(project.padKit)
  const beats = normalizeBeats(project.beats, project.patternClips)
  project.beats = beats.beats
  project.patternClips = bindPatternClips(beats.patternClips, project.tracks)
  repairArrangementIdentities(project)
  project.roll = { ...defaultRoll(), ...project.roll }
  project.quantize = normalizeQuantize(project.quantize)
  project.quantizePresets = project.quantizePresets ?? []
  project.record = { ...defaultRecord(project.loopEndSample || 0), ...(project.record || {}) }
  project.masterPlugins = (project.masterPlugins ?? []).map(fillInstrument)
  project.automation = project.automation ?? []
  project.presets = project.presets ?? []
  project.masterInserts = project.masterInserts ?? []
  for (const track of project.tracks) {
    normalizeTrackScaler(track)
    if (track.instrument === 'pads' || track.padKit) track.padKit = normalizePadKit(track.padKit)
    track.armed = track.armed === true
    track.plugins = (track.plugins ?? []).map(fillInstrument)
    track.sends = track.sends ?? []
    track.inserts = track.inserts ?? []
    track.output = track.output ?? null
    track.groupId = track.groupId ?? null
    if (track.inserts.length && track.plugins.length === 0) {
      for (const insert of track.inserts) track.plugins.push(fromLegacy(insert))
      track.inserts = []
    }
  }
  if (project.masterInserts.length && project.masterPlugins.length === 0) {
    for (const insert of project.masterInserts) project.masterPlugins.push(fromLegacy(insert))
    project.masterInserts = []
  }
  if (!project.masterPlugins.some((plugin) => plugin.pluginId === 'limiter')) {
    const limiter = createPlugin('limiter', 'Transparent')
    limiter.enabled = false
    project.masterPlugins.unshift(limiter)
  }
  if (!project.masterPlugins.some((plugin) => plugin.pluginId === 'meter')) {
    project.masterPlugins.push(createPlugin('meter'))
  }
  return normalizeMix(project)
}

export function fromLegacy(insert: Insert): PluginInstance {
  const plugin = createPlugin(insert.type === 'compressor' ? 'compressor' : insert.type === 'eq' ? 'eq' : insert.type === 'delay' ? 'delay' : 'reverb')
  plugin.enabled = insert.enabled
  const params = insert.params
  if (insert.type === 'eq') {
    plugin.params.lowG = params.low ?? 0
    plugin.params.midG = params.mid ?? 0
    plugin.params.midF = params.midFreq ?? 1000
    plugin.params.highG = params.high ?? 0
  } else if (insert.type === 'compressor') {
    plugin.params.threshold = params.threshold ?? -18
    plugin.params.ratio = params.ratio ?? 3
    plugin.params.attack = (params.attack ?? 0.01) * 1000
    plugin.params.release = (params.release ?? 0.12) * 1000
    plugin.params.knee = params.knee ?? 6
    plugin.params.makeup = params.makeup ?? 0
  } else if (insert.type === 'delay') {
    plugin.params.sync = 0
    plugin.params.time = (params.time ?? 0.25) * 1000
    plugin.params.feedback = params.feedback ?? 0.3
    plugin.params.mix = params.mix ?? 0.2
  } else {
    plugin.params.size = Math.min(1, (params.decay ?? 1.5) / 4)
    plugin.params.mix = params.mix ?? 0.18
    plugin.params.mode = 1
  }
  return plugin
}

export function presetParams(pluginId: string, name: string, user: UserPreset[]) {
  const factory = (FACTORY[pluginId] ?? []).find((item) => item.name === name)
  if (factory) return { ...defaultParams(pluginId), ...factory.params }
  const saved = user.find((item) => item.pluginId === pluginId && item.name === name)
  if (saved) return { ...defaultParams(pluginId), ...saved.params }
  return null
}

export function automationAt(lanes: AutomationLane[], pluginId: string, params: Record<string, number>, beat: number) {
  const next = { ...params }
  for (const lane of lanes) {
    if (lane.target && lane.target !== 'plugin') continue
    if (lane.pluginId !== pluginId || !lane.points.length) continue
    next[lane.param] = interpolate(lane.points, beat, params[lane.param] ?? 0)
  }
  return next
}

function interpolate(points: { beat: number; value: number }[], beat: number, fallback: number) {
  const sorted = [...points].sort((a, b) => a.beat - b.beat)
  if (beat <= sorted[0].beat) return sorted[0].value
  const last = sorted[sorted.length - 1]
  if (beat >= last.beat) return last.value
  for (let i = 1; i < sorted.length; i++) {
    if (beat <= sorted[i].beat) {
      const a = sorted[i - 1]
      const b = sorted[i]
      const span = b.beat - a.beat || 1
      return a.value + ((beat - a.beat) / span) * (b.value - a.value)
    }
  }
  return fallback
}
