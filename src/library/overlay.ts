/** One slot per key. Later rows replace earlier ones. The base array is updated in place. */
export function overlayRowsByKey<T extends { key: string }>(base: T[], extras: T[]): T[] {
  if (!extras.length) return base
  const index = new Map<string, number>()
  for (let i = 0; i < base.length; i++) {
    if (!index.has(base[i].key)) index.set(base[i].key, i)
  }
  for (const row of extras) {
    if (!row.key) continue
    const at = index.get(row.key)
    if (at == null) {
      index.set(row.key, base.length)
      base.push(row)
    } else {
      base[at] = row
    }
  }
  return base
}
