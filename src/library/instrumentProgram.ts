import { fillKeyboard, mapKeyRanges } from '../harbor/zones'
import { makeProgram, makeSample, makeZone, type SamplerProgram } from '../audio/multisample/types'
import type { InstrumentLayer, LibraryInstrument } from './group'
import { librarySampleUrl } from './samples'

function layerId(layer: InstrumentLayer) {
  return `lib:${layer.key}`
}

function groupHash(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 100000 + 1
}

/**
 * Map every sampled root across the keyboard.
 * Unsampled keys use the nearest root. Velocity bands and round-robins stay on their own samples.
 * One sample covers the whole keyboard from its root.
 */
export function programFromLibraryInstrument(instrument: LibraryInstrument): SamplerProgram {
  const samples = instrument.layers.map((layer) => makeSample({
    id: layerId(layer),
    url: librarySampleUrl(instrument.id, layer.key),
    format: 'wav',
  }))
  const groups = new Map<string, InstrumentLayer[]>()
  for (const layer of instrument.layers) {
    const id = `${layer.velLo}|${layer.velHi}|${layer.release ? 'r' : 'a'}`
    const list = groups.get(id) ?? []
    list.push(layer)
    groups.set(id, list)
  }
  const zones = [...groups.values()].flatMap((list) => {
    const spans = mapKeyRanges(list.map((layer) => layer.midi))
    const byNote = new Map<number, InstrumentLayer[]>()
    for (const layer of list) {
      const rows = byNote.get(layer.midi) ?? []
      rows.push(layer)
      byNote.set(layer.midi, rows)
    }
    return [...byNote.entries()].flatMap(([midi, rows]) => {
      const span = spans.get(midi) ?? { lokey: 0, hikey: 127 }
      const seqs = [...new Set(rows.map((row) => row.rr))].sort((a, b) => a - b)
      const cycling = seqs.length > 1
      const rrGroup = cycling ? groupHash(`${instrument.id}|${midi}|${rows[0].velLo}|${rows[0].release}`) : 0
      return rows.map((row) => makeZone({
        id: `zone:${layerId(row)}:${row.rr}`,
        sampleId: layerId(row),
        lokey: span.lokey,
        hikey: span.hikey,
        lovel: row.velLo,
        hivel: row.velHi,
        root: row.midi,
        seq: row.rr,
        seqLength: seqs.length,
        rrGroup,
        trigger: row.release ? 'release' : 'attack',
        loopMode: 'one-shot',
        ampeg: row.release
          ? { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.35 }
          : { attack: 0.008, hold: 0, decay: 0.18, sustain: 0.82, release: 0.4 },
      }))
    })
  })
  return fillKeyboard(makeProgram({
    id: instrument.id,
    name: instrument.name,
    author: instrument.pack,
    license: 'private',
    zones,
    samples,
    voices: 32,
    play: { tune: 0, attack: 0.008, decay: 0.18, sustain: 0.82, release: 0.4, tone: 16000 },
  }))
}
