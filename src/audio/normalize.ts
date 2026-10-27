import { createLoudness, dbToGain, measureLoudness } from './plugins/dsp'

export function normalizeAudio(channels: Float32Array[], sampleRate: number, mode: 'off' | 'peak' | 'lufs', target: number): Float32Array[] {
  if (mode === 'off') return channels
  const gain = mode === 'peak' ? peakGain(channels, target) : lufsGain(channels, sampleRate, target)
  if (!Number.isFinite(gain) || gain === 1) return channels.map((channel) => channel.slice())
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = (channel[i] || 0) * gain
    return out
  })
}

export function measureLufs(channels: Float32Array[], sampleRate: number) {
  const state = createLoudness(sampleRate)
  return measureLoudness(state, channels[0] ?? new Float32Array(0), channels[1] ?? null, sampleRate).lufs
}

function lufsGain(channels: Float32Array[], sampleRate: number, target: number) {
  const measured = measureLufs(channels, sampleRate)
  if (measured <= -70) return 1
  return dbToGain(target - measured)
}

function peakGain(channels: Float32Array[], targetDb: number) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i] || 0))
  }
  if (peak < 1e-8) return 1
  return dbToGain(targetDb) / peak
}
