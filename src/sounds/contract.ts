/**
 * SoundScout 2026-11-09 host contract.
 * Audio and the catalog are read from one pinned dataset commit.
 * `main` can move; saved projects and new downloads stay on this snapshot.
 */

export const SOUNDSCOUT_VERSION = 'soundscout-2026-11-09'

/** Dataset commit that contains catalogs/soundscout-2026-11-09.json and the 770 WAVs. */
export const SOUND_DATASET_COMMIT = '7a1ea9faef7f7813fff02c0a3b84910438949596'

export const SOUND_DATASET_BASE = `https://huggingface.co/datasets/cueharbor/sound-library/resolve/${SOUND_DATASET_COMMIT}`

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
