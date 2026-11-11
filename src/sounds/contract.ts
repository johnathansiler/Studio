/**
 * SoundScout 2026-11-09 host contract.
 * Audio and the catalog are read from one pinned dataset commit.
 * `main` can move; saved projects and new downloads stay on this snapshot.
 *
 * The catalog file is newer than the audio prefix on purpose.
 * Rows keep version soundscout-2026-11-09 and paths under that prefix.
 */

export const SOUNDSCOUT_VERSION = 'soundscout-2026-11-09'

/** Dataset commit that contains the catalog and the 807 unique WAVs (813 rows). */
export const SOUND_DATASET_COMMIT = 'ab0c3259dbd20c344efc9f8db5bc0d2206e0d2f8'

export const SOUND_DATASET_BASE = `https://huggingface.co/datasets/cueharbor/sound-library/resolve/${SOUND_DATASET_COMMIT}`

export const SOUND_VERSION_PREFIX = `${SOUNDSCOUT_VERSION}/`

/** Catalog filename. Separate from SOUNDSCOUT_VERSION so the 813-row file loads. */
export const SOUND_CATALOG_FILE = 'soundscout-2026-11-10'

export const SOUND_CATALOG_URL = `${SOUND_DATASET_BASE}/catalogs/${SOUND_CATALOG_FILE}.json`

export const LEGACY_INDEX_URL = `${SOUND_DATASET_BASE}/index.json`

/** Root folders kept for projects that already stored a library path. Not the active catalog. */
export const LEGACY_ROOT = /^(loops|one-shots|oneshots|ones)\//

export const PACK_LABEL: Record<string, string> = {
  'HW-MBASE': 'MBase kicks',
  'LEN-ZIP': 'Lentikula',
  'ORG-MEAD-NATURE': 'Organic nature',
  'ORG-MEAD-PERC': 'Organic percussion',
  'FS-HOLIZNA-ARCADE': 'Holizna arcade',
  'FS-HOLIZNA-LOFI': 'Holizna lo-fi',
  'FS-DEADROBOTMUSIC': 'Dead Robot Music',
  'FS-JOSEFPRES-PIANO': 'Josefpres piano',
}

export function packLabel(pack: string) {
  return PACK_LABEL[pack] ?? pack
}
