/**
 * Sound library pin. Audio and the catalog are read from one dataset commit.
 * `main` can move; saved projects and new downloads stay on this snapshot.
 *
 * The catalog filename can be newer than `version`. Row paths still use `version`.
 *
 * Bump only SOUND_LIBRARY_PIN when a new Hugging Face commit and catalog land.
 * version — catalog document version. Paths stay under `${version}/`.
 * commit — dataset commit that contains that catalog and the audio files.
 * catalogFile — filename under catalogs/, without `.json`.
 * The exports below are derived from this object. Do not set them on their own.
 */
export const SOUND_LIBRARY_PIN = {
  version: 'soundscout-2026-11-09',
  /** Dataset commit that contains the catalog and the 1202 unique WAVs (1208 rows). */
  commit: '0f06ae2f33f14b48bb1a549a16046c16aa47ffd2',
  /** Catalog filename. Separate from version so this file loads while paths stay on the version prefix. */
  catalogFile: 'soundscout-2026-11-17-4',
} as const

export const SOUNDSCOUT_VERSION = SOUND_LIBRARY_PIN.version

export const SOUND_DATASET_COMMIT = SOUND_LIBRARY_PIN.commit

export const SOUND_DATASET_BASE = `https://huggingface.co/datasets/cueharbor/sound-library/resolve/${SOUND_DATASET_COMMIT}`

export const SOUND_VERSION_PREFIX = `${SOUNDSCOUT_VERSION}/`

export const SOUND_CATALOG_FILE = SOUND_LIBRARY_PIN.catalogFile

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
  'RD-SINUS-FUEGO2': 'Boombap Fuego 2',
  'RD-SINUS-FUEGO3': 'Boombap Fuego 3',
  'RD-TRAPWIN-BLOODMOON': 'TrapWin Blood Moon',
  'EL-FISCHER-808': 'TR-808 (Fischer)',
  'EL-BEATTAB-909': 'TR-909 (BeatTab)',
  'EL-DION-707': 'TR-707 (Dion)',
  'EL-CLIPABAY': 'Clipabay',
  'EL-BAKER-909': 'TR-909 (Baker)',
  'AC-MULDJORD': 'MuldjordKit (DrumGizmo)',
  'AC-DRSKIT': 'DRSKit (DrumGizmo)',
  'AC-AVL-BLONDEBOP': 'AVL Blonde Bop',
}

export function packLabel(pack: string) {
  return PACK_LABEL[pack] ?? pack
}
