/** Browser-test object URLs. The additions sidecar is never signed as a WAV. */
export const LIBRARY_TEST_ADDITIONS_PATH = '/library-test/additions.json'

export function libraryTestObjectUrl(origin: string, key: string) {
  if (key === 'catalog/catalog-additions.json' || key.endsWith('catalog-additions.json')) {
    return `${origin}${LIBRARY_TEST_ADDITIONS_PATH}`
  }
  if (key.endsWith('.gz')) return `${origin}/library-test/catalog.json.gz`
  return `${origin}/library-test/audio.wav`
}
