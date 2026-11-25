/**
 * Existing 808 one-shots. Ids, paths, and keys are the catalog's.
 * The root is the catalog note, so that note plays the file at its recorded pitch.
 */

import { noteMidi } from '../../library/group'

export interface BassShot {
  id: string
  name: string
  key: string
  path: string
}

export const BASS808_SHOTS: readonly BassShot[] = [
  {
    id: 'hw-mbase-mbase-11-808-01-808-c1-wav',
    name: '01 808 - C1',
    key: 'C1',
    path: 'soundscout-2026-11-09/one-shots/drums/mbase11-kicks/mbase-11-808/01 808 - C1.wav',
  },
  {
    id: 'hw-mbase-mbase-11-808-06-808-f1-wav',
    name: '06 808 - F1',
    key: 'F1',
    path: 'soundscout-2026-11-09/one-shots/drums/mbase11-kicks/mbase-11-808/06 808 - F1.wav',
  },
  {
    id: 'hw-mbase-mbase-11-808-10-808-a1-wav',
    name: '10 808 - A1',
    key: 'A1',
    path: 'soundscout-2026-11-09/one-shots/drums/mbase11-kicks/mbase-11-808/10 808 - A1.wav',
  },
  {
    id: 'hw-mbase-mbase-11-808-dist-01-808-dist-c1-wav',
    name: '01 808 Dist - C1',
    key: 'C1',
    path: 'soundscout-2026-11-09/one-shots/drums/mbase11-kicks/mbase-11-808-dist/01 808 Dist - C1.wav',
  },
]

export function shotRoot(shot: BassShot) {
  return noteMidi(shot.key) ?? 36
}

export function shotById(id: string) {
  return BASS808_SHOTS.find((shot) => shot.id === id) ?? null
}
