export interface TonePreset {
  name: string
  category: string
  params: Record<string, number>
}

const tone = (name: string, category: string, params: Record<string, number>): TonePreset => ({ name, category, params })

export const SUB_PRESETS: TonePreset[] = [
  tone('Lead', 'Lead', { wave1: 0, mix2: 0.35, detune: 8, cutoff: 2400, res: 0.28, famt: 0.45, decay: 180, sustain: 0.55, m1d: 0.35, m1t: 0 }),
  tone('Sync', 'Lead', { sync: 1, wave1: 0, mix2: 0.55, detune: 12, cutoff: 3200, res: 0.2, famt: 0.3 }),
  tone('Soft', 'Keys', { wave1: 4, mix2: 0.15, detune: 4, cutoff: 1800, attack: 12, sustain: 0.8, famt: 0.15 }),
  tone('Chime', 'Bells', { wave1: 4, mix2: 0.4, wave2: 4, detune: 7, cutoff: 5000, attack: 2, decay: 420, sustain: 0.15, release: 600 }),
  tone('Stack', 'Lead', { uni: 3, uniDet: 12, mix2: 0.3, cutoff: 2600, res: 0.18, famt: 0.25 }),
  tone('Pulse', 'Keys', { wave1: 2, pw: 0.3, mix2: 0.2, lfo1: 0.25, mod1src: 0, mod1dst: 3, mod1amt: 0.4, cutoff: 2000 }),
  tone('Air', 'Pad', { attack: 600, release: 1200, cutoff: 2800, mix2: 0.5, mix3: 0.25, detune: 10, famt: 0.15, fxChor: 0.25 }),
  tone('Noise', 'FX', { wave1: 5, mix1: 0.8, mix2: 0, cutoff: 900, res: 0.4, attack: 20, decay: 300, sustain: 0.2, famt: 0.6 }),
  tone('Drop', 'Bass', { wave1: 4, mix2: 0.2, cutoff: 280, res: 0.4, famt: 0.7, decay: 160, sustain: 0.3, glide: 40 }),
  tone('Fifth', 'Lead', { mix2: 0.45, detune: 700, cutoff: 2200, res: 0.22, famt: 0.35 }),
  tone('Hollow', 'Texture', { wave1: 1, mix2: 0.5, detune: 6, cutoff: 900, res: 0.55, attack: 200, sustain: 0.6, fxRev: 0.2 }),
  tone('Ring', 'Bells', { ring: 1, wave1: 4, wave2: 0, mix2: 0.8, detune: 5, cutoff: 4200, decay: 360, sustain: 0.2 }),
]

export const FM_PRESETS: TonePreset[] = [
  tone('Electric', 'Keys', { ratio: 1, index: 1.6, decay: 280, sustain: 0.45, feedback: 0.15 }),
  tone('Tine', 'Keys', { ratio: 14, index: 0.8, decay: 500, sustain: 0.1, attack: 2 }),
  tone('Brass', 'Lead', { ratio: 1, index: 2.4, attack: 40, decay: 200, sustain: 0.7, algo: 1, lv3: 0.4 }),
  tone('Chime', 'Bells', { ratio: 3.5, index: 1.8, decay: 700, sustain: 0.05, op3: 7, lv3: 0.3 }),
  tone('Wood', 'Pluck', { ratio: 2, index: 1.2, attack: 2, decay: 120, sustain: 0.1, feedback: 0.2 }),
  tone('Marimba', 'Pluck', { ratio: 4, index: 1.5, decay: 240, sustain: 0, release: 80 }),
  tone('Scream', 'Lead', { ratio: 1, index: 4.2, feedback: 0.65, sustain: 0.6, cutoff: 0 }),
  tone('Soft', 'Pad', { ratio: 1, index: 0.6, attack: 500, release: 900, sustain: 0.7, algo: 5, lv3: 0.2 }),
  tone('Organ', 'Keys', { ratio: 2, index: 0.4, sustain: 0.9, decay: 80, attack: 8, algo: 5, lv3: 0.35 }),
  tone('Pluck', 'Pluck', { ratio: 1.5, index: 2, attack: 2, decay: 140, sustain: 0.05 }),
  tone('Glass', 'Bells', { ratio: 2.5, index: 1.1, op3: 5.2, lv3: 0.45, decay: 600, sustain: 0.1 }),
  tone('Growl', 'Bass', { ratio: 1, index: 3.2, feedback: 0.4, decay: 180, sustain: 0.4, algo: 2, lv3: 0.5 }),
  tone('Kalimba', 'Pluck', { ratio: 7, index: 1.3, decay: 320, sustain: 0, fixed: 0 }),
]

export const WAVE_PRESETS: TonePreset[] = [
  tone('Saw', 'Lead', { table: 1, position: 0.4, cutoff: 2400, res: 0.2, famt: 0 }),
  tone('Square', 'Keys', { table: 2, position: 0.2, cutoff: 1800 }),
  tone('Morph', 'Pad', { table: 3, position: 0.55, attack: 400, release: 800, fxChor: 0.3, cutoff: 3000 }),
  tone('Bell', 'Bells', { table: 4, position: 0.3, attack: 2, decay: 480, sustain: 0.15, cutoff: 6000 }),
  tone('Bass', 'Bass', { table: 1, position: 0.1, cutoff: 420, res: 0.35, decay: 160, sustain: 0.4 }),
  tone('Unison', 'Lead', { table: 1, uni: 3, uniDet: 10, position: 0.35, cutoff: 2600 }),
  tone('Fold', 'Texture', { table: 1, warp: 2, warpAmt: 0.45, cutoff: 2000, res: 0.3 }),
  tone('Bend', 'Lead', { table: 0, warp: 1, warpAmt: 0.8, cutoff: 3200 }),
  tone('PWM', 'Keys', { table: 2, warp: 3, pw: 0.3, cutoff: 2200 }),
  tone('Air', 'Pad', { table: 3, position: 0.8, attack: 700, release: 1400, fxRev: 0.28, cutoff: 4000 }),
  tone('Pluck', 'Pluck', { table: 1, position: 0.15, attack: 2, decay: 150, sustain: 0.1, cutoff: 3600 }),
  tone('Glass', 'Bells', { table: 4, position: 0.7, decay: 600, sustain: 0.1, fxDel: 0.2 }),
  tone('Growl', 'Bass', { table: 1, warp: 2, warpAmt: 0.6, cutoff: 500, res: 0.45, sustain: 0.45 }),
  tone('Sweep', 'FX', { table: 3, position: 0.9, lfo1: 0.15, attack: 20, cutoff: 1400, res: 0.4, fxRev: 0.2 }),
  tone('Choir', 'Texture', { table: 3, position: 0.45, uni: 2, uniDet: 6, attack: 180, sustain: 0.75, fxChor: 0.35 }),
]
