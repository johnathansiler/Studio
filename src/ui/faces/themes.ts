export type FaceFamily = 'eq' | 'dyn' | 'space' | 'mod' | 'color' | 'util' | 'inst'

export interface FaceTheme {
  id: string
  badge: string
  mark: string
  family: FaceFamily
  layout: 'knobs' | 'faders' | 'strips'
  panel: string
  ink: string
  accent: string
  accent2: string
  metal: string
}

function theme(
  id: string,
  badge: string,
  mark: string,
  family: FaceFamily,
  layout: FaceTheme['layout'],
  panel: string,
  accent: string,
  accent2: string,
  ink = '#f4f7f2',
  metal = '#2a3330',
): FaceTheme {
  return { id, badge, mark, family, layout, panel, ink, accent, accent2, metal }
}

export const FACE_THEMES: Record<string, FaceTheme> = {
  eq: theme('eq', 'Curve', 'CV', 'eq', 'knobs', '#12181c', '#3ec6ff', '#7ee0ff'),
  meq: theme('meq', 'Linear', 'LN', 'eq', 'knobs', '#10141a', '#8fd0ff', '#d6ecff'),
  deq: theme('deq', 'Follow', 'FL', 'eq', 'knobs', '#16141c', '#c084fc', '#f0abfc'),
  passive: theme('passive', 'Ivory', 'IV', 'eq', 'knobs', '#1c1812', '#e6c98a', '#fff1cc', '#f8f1e2', '#4a3d28'),
  pre: theme('pre', 'Strip', 'ST', 'eq', 'strips', '#14181a', '#7dcea0', '#d5f5e3'),
  channel: theme('channel', 'Console', 'CN', 'eq', 'strips', '#161a1c', '#5dade2', '#d4e6f1'),
  prop: theme('prop', 'Tilt', 'TL', 'eq', 'faders', '#141816', '#58d68d', '#abebc6'),
  focus: theme('focus', 'Focus', 'FC', 'eq', 'knobs', '#101418', '#48c9b0', '#a3e4d7'),
  compressor: theme('compressor', 'Press', 'PR', 'dyn', 'knobs', '#1a140f', '#f5b041', '#fdebd0', '#fff8ee', '#3d2e1e'),
  fet: theme('fet', 'Latch', 'LT', 'dyn', 'knobs', '#1a120f', '#e74c3c', '#f5b7b1'),
  opto: theme('opto', 'Glow', 'GL', 'dyn', 'knobs', '#1a140c', '#f4d03f', '#fcf3cf'),
  bus: theme('bus', 'Desk', 'DK', 'dyn', 'strips', '#121614', '#27ae60', '#abebc6'),
  vari: theme('vari', 'Mu', 'MU', 'dyn', 'knobs', '#16120e', '#dc7633', '#f6ddcc', '#fff6ee', '#3d2a1c'),
  gate: theme('gate', 'Hold', 'HD', 'dyn', 'knobs', '#101612', '#2ecc71', '#d5f5e3'),
  limiter: theme('limiter', 'Ceil', 'CL', 'dyn', 'faders', '#1a1012', '#ff5a6a', '#ffd0d6'),
  deesser: theme('deesser', 'Hiss', 'HS', 'dyn', 'knobs', '#1a1018', '#e056c2', '#f5b7e4'),
  peak: theme('peak', 'Peak', 'PK', 'dyn', 'faders', '#140e12', '#ff6b6b', '#ffd0d0'),
  glue: theme('glue', 'Glue', 'GU', 'dyn', 'knobs', '#161410', '#e0b15a', '#fdebd0'),
  brick: theme('brick', 'Brick', 'BR', 'dyn', 'faders', '#120e10', '#ff4d4d', '#ffc9c9'),
  maxim: theme('maxim', 'Level', 'LV', 'dyn', 'faders', '#101216', '#79b8d4', '#d6eaf8'),
  mbcomp: theme('mbcomp', 'Bands', 'BD', 'dyn', 'strips', '#12141a', '#85c1e9', '#d4e6f1'),
  delay: theme('delay', 'Echo Bay', 'EB', 'space', 'knobs', '#0e141c', '#5dade2', '#d4e6f1'),
  reverb: theme('reverb', 'Room', 'RM', 'space', 'knobs', '#10141c', '#7d8cff', '#d6dbff'),
  plate: theme('plate', 'Plate', 'PL', 'space', 'knobs', '#14161c', '#aab7ff', '#e8eaff'),
  hall: theme('hall', 'Hall', 'HL', 'space', 'knobs', '#101018', '#9b8cff', '#e0d9ff'),
  conv: theme('conv', 'Space', 'SP', 'space', 'knobs', '#101416', '#48c9b0', '#d0f5ee'),
  echo: theme('echo', 'Repeat', 'RP', 'space', 'knobs', '#16120e', '#e59866', '#fdebd0'),
  bbd: theme('bbd', 'Bucket', 'BB', 'space', 'knobs', '#161410', '#f0b429', '#fdebd0'),
  digital: theme('digital', 'Digits', 'DG', 'space', 'knobs', '#0e1216', '#5dccff', '#d6f4ff'),
  chorus: theme('chorus', 'Shimmer', 'SH', 'mod', 'knobs', '#14101a', '#bb8fce', '#f5eef8'),
  doubler: theme('doubler', 'Twin', 'TW', 'mod', 'knobs', '#10161a', '#45b39d', '#d0f2ea'),
  ensemble: theme('ensemble', 'Ensemble', 'EN', 'mod', 'knobs', '#141018', '#af7ac5', '#f5eef8'),
  phase: theme('phase', 'Sweep', 'SW', 'mod', 'knobs', '#14120e', '#f5b041', '#fdebd0'),
  rotor: theme('rotor', 'Spin', 'SN', 'mod', 'knobs', '#14160e', '#7dcea0', '#e8f8f0'),
  saturator: theme('saturator', 'Warmth', 'WM', 'color', 'knobs', '#1a120c', '#e67e22', '#fdebd0', '#fff8f0', '#3d2918'),
  tape: theme('tape', 'Reel', 'RL', 'color', 'knobs', '#1a140e', '#d35400', '#f6ddcc', '#fff6ee', '#3d2a1c'),
  sum: theme('sum', 'Summer', 'SM', 'color', 'knobs', '#16140e', '#f7dc6f', '#fcf3cf'),
  mtape: theme('mtape', 'Oxide', 'OX', 'color', 'knobs', '#1a1210', '#e74c3c', '#fadbd8'),
  clip: theme('clip', 'Clip', 'CP', 'color', 'faders', '#160e10', '#ff7675', '#ffd6d6'),
  pitch: theme('pitch', 'Shift', 'SF', 'util', 'knobs', '#101418', '#73c48f', '#d5f5e3'),
  image: theme('image', 'Width', 'WD', 'util', 'faders', '#101418', '#5dade2', '#d6eaf8'),
  msbox: theme('msbox', 'Center', 'MS', 'util', 'faders', '#121416', '#85929e', '#e5e8e8'),
  dither: theme('dither', 'Bits', 'BT', 'util', 'knobs', '#121212', '#b0b8b4', '#ecf0f1'),
  meter: theme('meter', 'Scope', 'SC', 'util', 'knobs', '#0e1210', '#73c48f', '#d5f5e3'),
  amp: theme('amp', 'Stack', 'SK', 'inst', 'knobs', '#1c140e', '#e8a04a', '#fdebd0', '#fff6ea', '#4a3420'),
  sampler: theme('sampler', 'Pad', 'PD', 'inst', 'knobs', '#12161c', '#79b8d4', '#d6eaf8'),
  looper: theme('looper', 'Loop', 'LP', 'inst', 'knobs', '#121816', '#73c48f', '#d5f5e3'),
  tune: theme('tune', 'Tune', 'TN', 'util', 'knobs', '#1a160f', '#e8c47a', '#fdebd0'),
  scaler: theme('scaler', 'Chords', 'SC', 'inst', 'knobs', '#151b23', '#3ec8de', '#d8fbff', '#e8fbff', '#243040'),
}

export function themeFor(id: string): FaceTheme {
  return FACE_THEMES[id] ?? theme(id, id, id.slice(0, 2).toUpperCase(), 'util', 'knobs', '#141816', '#73c48f', '#d5f5e3')
}

export const TOGGLE_IDS = new Set(['bright', 'cab', 'axis', 'mute', 'sync', 'pingpong', 'tube', 'linear', 'reverse', 'keys', 'mono', 'record', 'stretch'])
