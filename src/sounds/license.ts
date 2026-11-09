/**
 * No-attribution licenses only.
 * CC0, public domain, Unlicense, and the same kind of informal grant.
 * A grant is not relabeled as CC0. Attribution-required licenses stay out.
 */
export function licenseAllowed(license: string, attributionRequired?: boolean) {
  if (attributionRequired === true) return false
  const text = license.trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')
  if (!text) return false
  if (text === 'cc0' || text.startsWith('cc0 ') || text.startsWith('cc0-') || text.startsWith('cc-0') || text.startsWith('cc zero') || text.startsWith('creative commons zero')) return true
  if (text === 'public domain' || text.startsWith('public domain')) return true
  if (text === 'unlicense' || text.startsWith('unlicense ') || text.startsWith('unlicense-')) return true
  if (text === 'informal-creator-grant' || text === 'informal creator grant') return true
  return false
}
