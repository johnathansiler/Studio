/** Genres the Ideas generator offers. Ids match the existing style library. */

export const PART_GENRES = [
  { id: 'boom-bap', name: 'Boom bap', style: 'boom-bap' },
  { id: 'trap', name: 'Trap', style: 'trap' },
  { id: 'lofi', name: 'Lo-fi', style: 'lofi' },
  { id: 'rnb', name: 'R&B', style: 'rnb' },
  { id: 'house', name: 'House', style: 'house' },
  { id: 'drill', name: 'Drill', style: 'drill' },
  { id: 'pop', name: 'Pop', style: 'pop' },
] as const

export function partGenre(id: string) {
  return PART_GENRES.find((genre) => genre.id === id) ?? PART_GENRES.find((genre) => genre.id === 'pop')!
}
