const DENIED_CATEGORIES = new Set([
  'kick', 'drums', 'drum', 'snare', 'hat', 'hi-hat', 'hihat', 'clap', 'percussion', 'perc',
  'cymbal', 'tom', 'rim', 'noise',
])

/** Drums, one-shots, and noise. No pitch-class name is attached. */
export function clipDeniesKey(clip: { soundType?: string; soundRole?: string; soundCategory?: string }) {
  const type = (clip.soundType ?? '').toLowerCase().replace(/[\s_]+/g, '-')
  if (type === 'one-shot' || type === 'oneshot') return true
  const role = (clip.soundRole ?? '').toLowerCase()
  if (role.includes('drum')) return true
  const category = (clip.soundCategory ?? '').toLowerCase().replace(/[\s_]+/g, '-')
  return DENIED_CATEGORIES.has(category)
}
