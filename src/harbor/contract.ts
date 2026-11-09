/**
 * Instrument library host contract.
 * The dataset commit and catalog file live in this one constant.
 */
export const INSTRUMENT_LIBRARY = {
  dataset: 'cueharbor/instrument-library',
  revision: '2f1b999bdffd554de70079280b238fcbb185d93e',
  catalog: 'catalog.json',
} as const

export function instrumentLibraryBase(library = INSTRUMENT_LIBRARY) {
  return `https://huggingface.co/datasets/${library.dataset}/resolve/${library.revision}`
}

export function instrumentCatalogUrl(library = INSTRUMENT_LIBRARY) {
  return `${instrumentLibraryBase(library)}/${library.catalog}`
}

/** Hugging Face file listing for one folder. Not an audio URL. */
export function instrumentTreeUrl(path: string, library = INSTRUMENT_LIBRARY) {
  const clean = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return `https://huggingface.co/api/datasets/${library.dataset}/tree/${library.revision}/${clean.split('/').map(encodeURIComponent).join('/')}`
}
