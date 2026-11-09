/**
 * SoundScout 2026-11-09 host contract.
 * These URLs are the publish target. They are not verified live until the
 * dataset upload finishes with the user's Hugging Face token.
 */

export const SOUNDSCOUT_VERSION = 'soundscout-2026-11-09'

export const SOUND_DATASET_BASE = 'https://huggingface.co/datasets/cueharbor/sound-library/resolve/main'

export const SOUND_VERSION_PREFIX = `${SOUNDSCOUT_VERSION}/`

export const SOUND_CATALOG_URL = `${SOUND_DATASET_BASE}/catalogs/${SOUNDSCOUT_VERSION}.json`

export const LEGACY_INDEX_URL = `${SOUND_DATASET_BASE}/index.json`

/** Root folders kept for projects that already stored a library path. Not the active catalog. */
export const LEGACY_ROOT = /^(loops|one-shots|oneshots|ones)\//

export const PACK_LABEL: Record<string, string> = {
  'HW-MBASE': 'MBase kicks',
  'LEN-ZIP': 'Lentikula',
  'ORG-MEAD-NATURE': 'Organic nature',
  'ORG-MEAD-PERC': 'Organic percussion',
}

export function packLabel(pack: string) {
  return PACK_LABEL[pack] ?? pack
}
