import { fillKeyboard, mapKeyRanges } from '../harbor/zones'
import { makeProgram, makeSample, makeZone, type SamplerProgram } from '../audio/multisample/types'
import { favoriteSounds, replaceFavorites, type FavoriteSound } from '../library/favorites'
import { chordQualityLabel, looseMidi, looseTitle, parseFamilySuffix, parseLooseName, type LooseName } from '../library/looseName'
import { recentSounds, replaceRecent, type RecentSound } from '../library/recent'
import type { SoundEntry } from './types'

export interface LooseMember {
  entry: SoundEntry
  midi: number
  velLo?: number
  velHi?: number
}

export interface LooseGroup {
  id: string
  name: string
  role: string
  folder: string
  pack: string
  members: LooseMember[]
}

const groups = new Map<string, LooseGroup>()
const memberToGroup = new Map<string, string>()

export function looseGroup(id: string) {
  return groups.get(id) ?? null
}

export function looseGroupForMember(id: string) {
  const groupId = memberToGroup.get(id)
  return groupId ? groups.get(groupId) ?? null : null
}

/** Stars and recents saved against A.wav follow the grouped Bass instrument. */
export function retargetSoundMemory(entries: SoundEntry[]) {
  presentSoundEntries(entries)
  if (!memberToGroup.size) return
  const nextFavorites = foldSoundFavorites(favoriteSounds())
  if (nextFavorites) replaceFavorites(nextFavorites)
  const nextRecent = foldSoundRecent(recentSounds())
  if (nextRecent) replaceRecent(nextRecent)
}

function foldSoundFavorites(items: FavoriteSound[]) {
  let changed = false
  const next: FavoriteSound[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const raw = item.sound?.id || item.legacyId || item.id.replace(/^catalog:/, '')
    const group = looseGroupForMember(raw)
    if (!group) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        next.push(item)
      }
      continue
    }
    const id = `catalog:${group.id}`
    changed = true
    if (seen.has(id)) continue
    seen.add(id)
    next.push({
      ...item,
      id,
      name: group.name,
      detail: 'Instrument',
      kind: 'catalog',
      legacyId: item.legacyId || item.id,
      sound: {
        ...group.members[0].entry,
        id: group.id,
        name: group.name,
        type: 'instrument',
      },
    })
  }
  return changed ? next : null
}

function foldSoundRecent(items: RecentSound[]) {
  let changed = false
  const next: RecentSound[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const raw = item.sound?.id || item.id.replace(/^catalog:/, '')
    const group = looseGroupForMember(raw)
    if (!group) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        next.push(item)
      }
      continue
    }
    const id = `catalog:${group.id}`
    changed = true
    if (seen.has(id)) continue
    seen.add(id)
    next.push({
      ...item,
      id,
      name: group.name,
      detail: 'Instrument',
      kind: 'catalog',
      sound: {
        ...group.members[0].entry,
        id: group.id,
        name: group.name,
        type: 'instrument',
      },
    })
  }
  return changed ? next : null
}

function stemOf(path: string, name: string) {
  const file = (path.split('/').pop() || name).replace(/\.[a-z0-9]+$/i, '')
  return file || name
}

function folderOf(path: string) {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function roleKey(entry: SoundEntry, parsed: LooseName, folder: string) {
  if (parsed.role) return parsed.role
  const folderName = folder.split('/').filter(Boolean).pop()?.toLowerCase() || ''
  if (folderName && !/^(samples?|notes?|wavs?|audio)$/i.test(folderName)) return folderName
  const role = (entry.role || '').toLowerCase()
  if (!role || role === 'one_shot' || role === 'one-shot') return ''
  return role
}

function hashId(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `loose_${(hash >>> 0).toString(36)}`
}

function octaveFor(entry: SoundEntry, folder: string, role: string) {
  const hay = `${entry.category ?? ''} ${entry.role ?? ''} ${folder} ${role} ${entry.pack ?? ''}`.toLowerCase()
  if (/bass|sub|808|contrabass/.test(hay)) return 1
  if (/piano|keys|organ|guitar|harp/.test(hay)) return 2
  return 3
}

function midiOf(parsed: LooseName, entry: SoundEntry, folder: string, role: string) {
  if (parsed.midi != null) return parsed.midi
  if (parsed.pitchClass == null) return null
  return looseMidi(parsed.pitchClass, octaveFor(entry, folder, role))
}

class Union {
  parent: number[]
  constructor(count: number) {
    this.parent = Array.from({ length: count }, (_, index) => index)
  }
  find(index: number): number {
    const parent = this.parent[index]
    if (parent === index) return index
    const root = this.find(parent)
    this.parent[index] = root
    return root
  }
  join(a: number, b: number) {
    const left = this.find(a)
    const right = this.find(b)
    if (left !== right) this.parent[right] = left
  }
}

/**
 * Note files that share a folder or a pack, and the same role, become one instrument.
 * The stored rows stay on disk. This is the list the browser shows.
 */
export function presentSoundEntries(entries: SoundEntry[]): SoundEntry[] {
  groups.clear()
  memberToGroup.clear()
  const notes: { entry: SoundEntry; parsed: LooseName; folder: string; role: string; midi: number; quality: string }[] = []
  const keep = new Set<SoundEntry>()
  for (const entry of entries) {
    if (entry.type === 'loop') {
      keep.add(entry)
      continue
    }
    const family = parseFamilySuffix(stemOf(entry.path, entry.name)) || parseFamilySuffix(entry.name)
    if (family) {
      const folder = folderOf(entry.path)
      const quality = chordQualityLabel(family.quality)
      const base = family.base.toLowerCase() || roleKey(entry, { midi: null, pitchClass: family.pitchClass, role: '' }, folder)
      const role = `${base} ${quality}`.trim().toLowerCase()
      const octave = family.octave ?? octaveFor(entry, folder, role)
      const midi = looseMidi(family.pitchClass, octave)
      if (midi == null) {
        keep.add(entry)
        continue
      }
      notes.push({
        entry,
        parsed: { midi, pitchClass: null, role },
        folder,
        role,
        midi,
        quality,
      })
      continue
    }
    const parsed = parseLooseName(stemOf(entry.path, entry.name)) || parseLooseName(entry.name)
    if (!parsed) {
      keep.add(entry)
      continue
    }
    const folder = folderOf(entry.path)
    const role = roleKey(entry, parsed, folder)
    const midi = midiOf(parsed, entry, folder, role)
    if (midi == null) {
      keep.add(entry)
      continue
    }
    notes.push({ entry, parsed, folder, role, midi, quality: '' })
  }
  const union = new Union(notes.length)
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (notes[i].role !== notes[j].role) continue
      const sameFolder = Boolean(notes[i].folder) && notes[i].folder === notes[j].folder
      const samePack = Boolean(notes[i].entry.pack) && notes[i].entry.pack === notes[j].entry.pack
      if (sameFolder || samePack) union.join(i, j)
    }
  }
  const buckets = new Map<number, typeof notes>()
  for (let i = 0; i < notes.length; i++) {
    const root = union.find(i)
    const list = buckets.get(root) ?? []
    list.push(notes[i])
    buckets.set(root, list)
  }
  const listed = [...keep]
  for (const bucket of buckets.values()) {
    const pitches = new Set(bucket.map((item) => item.midi))
    const chordFamily = bucket.filter((item) => item.quality).length >= 2
    if ((bucket.length < 2 || pitches.size < 2) && !chordFamily) {
      for (const item of bucket) listed.push(item.entry)
      continue
    }
    const role = bucket.find((item) => item.parsed.role)?.parsed.role || bucket[0].role
    const folderName = bucket[0].folder.split('/').filter(Boolean).pop() || ''
    const pack = bucket[0].entry.pack || ''
    const titled = looseTitle(role || folderName || pack || 'Instrument')
    const packTitle = looseTitle(pack)
    const chordGroup = bucket.some((item) => item.quality)
    const name = chordGroup && packTitle && !titled.toLowerCase().includes(packTitle.toLowerCase())
      ? `${packTitle} - ${titled}`
      : titled
    const id = hashId([name, bucket[0].folder, pack, role, ...bucket.map((item) => item.entry.id).sort()].join('\n'))
    const members = rootMembers(bucket)
    const group: LooseGroup = { id, name, role, folder: bucket[0].folder, pack, members }
    groups.set(id, group)
    for (const item of bucket) memberToGroup.set(item.entry.id, id)
    const sample = bucket[0].entry
    listed.push({
      ...sample,
      id,
      name,
      type: 'instrument',
      path: sample.path,
      category: sample.category || role || folderName || undefined,
      role: role || sample.role,
      tags: [...new Set([...sample.tags, 'multisample', name.toLowerCase()])],
    })
  }
  listed.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return listed
}

/** One sample per root. Chord quality is a separate instrument, so every zone hears the full velocity range. */
function rootMembers(bucket: { entry: SoundEntry; midi: number; quality: string }[]): LooseMember[] {
  const byMidi = new Map<number, { entry: SoundEntry; midi: number }>()
  for (const item of bucket) {
    const prev = byMidi.get(item.midi)
    if (!prev || item.entry.id.localeCompare(prev.entry.id) < 0) byMidi.set(item.midi, item)
  }
  return [...byMidi.values()].map((item) => ({ entry: item.entry, midi: item.midi }))
}

export function samplerFromNotes(id: string, name: string, notes: { midi: number; bufferId: string; sampleRate: number; velLo?: number; velHi?: number }[]): SamplerProgram {
  const rows = notes
    .map((note) => ({ ...note, velLo: note.velLo ?? 1, velHi: note.velHi ?? 127 }))
    .sort((a, b) => a.midi - b.midi || a.velLo - b.velLo)
  const bands = new Map<string, typeof rows>()
  for (const row of rows) {
    const id = `${row.velLo}|${row.velHi}`
    const list = bands.get(id) ?? []
    if (!list.some((item) => item.midi === row.midi)) list.push(row)
    bands.set(id, list)
  }
  const samples = rows.map((row) => makeSample({
    id: `smp:${row.bufferId}`,
    bufferId: row.bufferId,
    sampleRate: row.sampleRate,
    url: '',
  }))
  const zones = [...bands.values()].flatMap((band) => {
    const spans = mapKeyRanges(band.map((row) => row.midi))
    return band.map((row) => {
      const span = spans.get(row.midi) ?? { lokey: 0, hikey: 127 }
      return makeZone({
        id: `zone:${row.bufferId}`,
        sampleId: `smp:${row.bufferId}`,
        lokey: span.lokey,
        hikey: span.hikey,
        lovel: row.velLo,
        hivel: row.velHi,
        root: row.midi,
        trigger: 'attack',
        loopMode: 'one-shot',
      })
    })
  })
  return fillKeyboard(makeProgram({
    id,
    name,
    license: 'private',
    zones,
    samples,
    voices: 32,
    play: { tune: 0, attack: 0.008, decay: 0.18, sustain: 0.82, release: 0.4, tone: 16000 },
  }))
}
