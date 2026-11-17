/**
 * Licenses the library may load.
 * CC0, public domain, Unlicense, and the informal grant need no attribution.
 * Creator kits and the unaltered Baker 909 set are allowed for personal non-commercial use.
 * CC BY and CC BY-SA load only when the row requires attribution, and the credit is shown.
 */

function licenseText(license: string) {
  return license.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

function attributionLicense(text: string) {
  return text === 'cc by 4.0' || text === 'cc by sa 3.0'
}

/** A NOT_CC0 license class may still be kept for these personal-use and attribution licenses. */
export function licenseKeptWhenNotCc0(license: string) {
  const text = licenseText(license)
  return text === 'informal creator grant'
    || text === 'free creator kit'
    || text === 'free noncommercial unaltered'
    || attributionLicense(text)
}

export function licenseAllowed(license: string, attributionRequired?: boolean) {
  const text = licenseText(license)
  if (!text) return false
  if (attributionRequired === true) return attributionLicense(text)
  if (attributionLicense(text)) return false
  if (text === 'cc0' || text.startsWith('cc0 ') || text.startsWith('cc zero') || text.startsWith('creative commons zero')) return true
  if (text === 'public domain' || text.startsWith('public domain')) return true
  if (text === 'unlicense' || text.startsWith('unlicense ')) return true
  if (text === 'informal creator grant') return true
  if (text === 'free creator kit') return true
  if (text === 'free noncommercial unaltered') return true
  return false
}

/** License, required credit, and source, in the same order the sound list shows. */
export function soundInfoLine(entry: {
  license?: string
  attributionText?: string
  source?: string
  licenseUrl?: string
  creator?: string
}) {
  const parts = [entry.license, entry.attributionText, entry.creator, entry.source, entry.licenseUrl]
  return parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' · ')
}
