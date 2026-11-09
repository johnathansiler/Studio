import { licenseAllowed } from '../sounds/license'

export { licenseAllowed }

/**
 * The words on screen match the grant.
 * Public domain and Unlicense are not relabeled as CC0.
 */
export function licenseLabel(license: string) {
  const text = license.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  if (!text) return ''
  if (text === 'cc0' || text.startsWith('cc0 ') || text.startsWith('cc0-') || text.startsWith('cc-0') || text.startsWith('cc zero') || text.startsWith('creative commons zero')) return 'CC0'
  if (text === 'public domain' || text.startsWith('public domain')) return 'Public domain'
  if (text === 'unlicense' || text.startsWith('unlicense ') || text.startsWith('unlicense-')) return 'Unlicense'
  if (text === 'informal-creator-grant' || text === 'informal creator grant') return 'Informal grant'
  return license.trim()
}
