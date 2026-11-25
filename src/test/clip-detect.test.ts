import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderStretch } from '../audio/stretch/engine'
import { detectKey, detectTempo, hearingOf } from '../analysis/clipKey'
import { handleClipDetect } from '../analysis/clipWorker'
import { altReadout, keyReadout, relateTempo, tempoForSong, tempoReadout } from '../model/clipHearing'
import { migrateProject } from '../model/schema'
import { createEmptyProject, type AudioClip } from '../model/types'
import { createPlugin } from '../audio/plugins/catalog'
import { tuneBlockScale, tuneScaleOf, tuneSnapMidi } from '../audio/plugins/autoTune'
import { ProjectStore } from '../state/store'
import { PhoneDock } from '../ui/phoneDock'

function midiHz(note: number, cents = 0) {
  return 440 * 2 ** ((note - 69) / 12 + cents / 1200)
}

function addTone(data: Float32Array, note: number, rate: number, cents: number, amp: number) {
  const freq = midiHz(note, cents)
  for (let h = 1; h <= 5; h++) {
    const f = freq * h
    if (f >= rate * 0.45) break
    const partial = amp / (h * h)
    for (let i = 0; i < data.length; i++) {
      const t = i / rate
      const env = Math.min(1, t / 0.012) * Math.exp(-t * (0.7 + h * 0.15))
      data[i] += Math.sin(2 * Math.PI * f * t) * partial * env
    }
  }
}

function chord(notes: number[], seconds: number, rate: number, cents: number) {
  const data = new Float32Array(Math.round(seconds * rate))
  const bass = notes[0] - 12
  addTone(data, bass, rate, cents, 0.34)
  for (const note of notes) addTone(data, note, rate, cents, 0.16)
  return data
}

function concat(parts: Float32Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function progression(degrees: number[][], root: number, rate: number, cents: number, tempo = 120) {
  const seconds = (2 * 60) / tempo
  return concat(degrees.map((shape) => chord(shape.map((interval) => 60 + root + interval), seconds, rate, cents)))
}

const MAJOR_CADENCE = [[0, 4, 7], [5, 9, 0], [7, 11, 2], [0, 4, 7]]
const MINOR_CADENCE = [[0, 3, 7], [5, 8, 0], [7, 11, 2], [0, 3, 7]]
const MAJOR_POP = [[0, 4, 7], [7, 11, 2], [9, 0, 4], [5, 9, 0]]
const MINOR_POP = [[0, 3, 7], [5, 8, 0], [8, 0, 3], [7, 11, 2]]
const MINOR_AXIS = [[0, 3, 7], [8, 0, 3], [3, 7, 10], [10, 2, 5]]

function noise(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

function clicks(bpm: number, beats: number, rate: number) {
  const beat = (60 / bpm) * rate
  const data = new Float32Array(Math.round(beat * beats))
  for (let hit = 0; hit < beats; hit++) {
    const at = Math.round(hit * beat)
    for (let i = 0; i < 220 && at + i < data.length; i++) {
      const env = Math.exp(-i / 32)
      data[at + i] += Math.sin((2 * Math.PI * 1800 * i) / rate) * env * 0.85
    }
  }
  return data
}

function burst(data: Float32Array, at: number, rate: number, amp: number, hz: number) {
  for (let i = 0; i < 160 && at + i < data.length; i++) {
    const env = Math.exp(-i / 26)
    data[at + i] += (Math.sin((2 * Math.PI * hz * i) / rate) * 0.55 + noise(at + i * 13) * 0.45) * env * amp
  }
}

/** Kick on 1 and 3, snare on 2 and 4, with quiet hats. The beat is the loud part. */
function drums(bpm: number, bars: number, rate: number) {
  const beat = (60 / bpm) * rate
  const beats = bars * 4
  const data = new Float32Array(Math.round(beat * beats))
  for (let hit = 0; hit < beats; hit++) {
    const at = Math.round(hit * beat)
    if (hit % 2 === 0) burst(data, at, rate, 0.9, 62)
    else burst(data, at, rate, 0.82, 190)
    const hatAt = at + Math.round(beat / 2)
    burst(data, hatAt, rate, 0.08, 3200)
  }
  return data
}

function names(root: number, minor: boolean) {
  return `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][root]} ${minor ? 'minor' : 'major'}`
}

describe('clip key and tempo', () => {
  it('names major and minor progressions, including detune and a stretch', () => {
    const rate = 22050
    const offsets = [-30, 0, 30]
    const families: { name: string; degrees: number[][]; minor: boolean }[] = [
      { name: 'major cadence', degrees: MAJOR_CADENCE, minor: false },
      { name: 'minor cadence', degrees: MINOR_CADENCE, minor: true },
      { name: 'major pop', degrees: MAJOR_POP, minor: false },
      { name: 'minor pop', degrees: MINOR_POP, minor: true },
    ]
    const misses: string[] = []
    let total = 0
    let hits = 0
    const byFamily = new Map<string, { hit: number; total: number }>()
    for (const family of families) {
      const stat = { hit: 0, total: 0 }
      byFamily.set(family.name, stat)
      for (let root = 0; root < 12; root++) {
        for (const cents of offsets) {
          total++
          stat.total++
          const audio = progression(family.degrees, root, rate, cents)
          const heard = detectKey(audio, rate)
          const ok = heard.clear && heard.root === root && (heard.scale === 'aeolian') === family.minor
          if (ok) {
            hits++
            stat.hit++
          } else {
            misses.push(`${family.name} ${names(root, family.minor)} ${cents}c -> ${heard.label} tune ${heard.cents} corr ${heard.best?.corr.toFixed(2)} tonal ${heard.tonal.toFixed(3)} alt ${heard.alt?.name ?? ''}`)
          }
        }
      }
    }
    const accuracy = hits / total
    const lines = [...byFamily.entries()].map(([name, stat]) => `${name} ${(100 * stat.hit / stat.total).toFixed(1)}% (${stat.hit}/${stat.total})`)
    console.log(`key accuracy ${(100 * accuracy).toFixed(1)}% (${hits}/${total})`)
    for (const line of lines) console.log(line)
    if (misses.length) console.log(misses.slice(0, 24).join('\n'))
    expect(accuracy).toBeGreaterThanOrEqual(0.9)
    const cadence = (byFamily.get('major cadence')!.hit + byFamily.get('minor cadence')!.hit) / (byFamily.get('major cadence')!.total + byFamily.get('minor cadence')!.total)
    expect(cadence).toBeGreaterThanOrEqual(0.95)

    let axisTop = 0
    for (let root = 0; root < 12; root++) {
      const audio = progression(MINOR_AXIS, root, rate, 0)
      const heard = detectKey(audio, rate)
      const relative = (root + 3) % 12
      const top = (heard.root === root && heard.scale === 'aeolian') || (heard.root === relative && heard.scale === 'ionian')
      const second = heard.alt && ((heard.alt.root === root && heard.alt.minor) || (heard.alt.root === relative && !heard.alt.minor))
      if (top || second) axisTop++
    }
    console.log(`minor axis in top 2: ${axisTop}/12`)
    expect(axisTop).toBeGreaterThanOrEqual(10)

    const stretched = renderStretch([progression(MAJOR_CADENCE, 0, rate, 20)], rate, { ratio: 1.25, semitones: 2, mode: 'pro', quality: 'hq' })[0]
    const after = detectKey(stretched, rate)
    expect(after.clear).toBe(true)
    expect(after.root).toBe(2)
    expect(after.scale).toBe('ionian')
    expect(after.alt?.name.length).toBeGreaterThan(0)
  }, 120000)

  it('reads click and drum tempos, including after a stretch', () => {
    const rate = 22050
    const targets = [72, 90, 100, 108, 120, 128, 140, 168]
    const misses: string[] = []
    let hits = 0
    for (const bpm of targets) {
      const click = detectTempo(clicks(bpm, 16, rate), rate)
      const drum = detectTempo(drums(bpm, 4, rate), rate)
      if (Math.abs(click.bpm - bpm) <= 2) hits++
      else misses.push(`click ${bpm} -> ${click.bpm}`)
      if (Math.abs(drum.bpm - bpm) <= 2) hits++
      else misses.push(`drum ${bpm} -> ${drum.bpm}`)
    }
    const slower = renderStretch([clicks(120, 16, rate)], rate, { ratio: 1.5, mode: 'beats', quality: 'hq' })[0]
    const faster = renderStretch([clicks(100, 16, rate)], rate, { ratio: 0.8, mode: 'beats', quality: 'hq' })[0]
    const slowTempo = detectTempo(slower, rate)
    const fastTempo = detectTempo(faster, rate)
    if (Math.abs(slowTempo.bpm - 80) <= 2) hits++
    else misses.push(`stretch 80 -> ${slowTempo.bpm}`)
    if (Math.abs(fastTempo.bpm - 125) <= 2) hits++
    else misses.push(`stretch 125 -> ${fastTempo.bpm}`)
    const total = targets.length * 2 + 2
    console.log(`tempo accuracy ${(100 * hits / total).toFixed(1)}% (${hits}/${total})`)
    if (misses.length) console.log(misses.join('\n'))
    expect(hits / total).toBeGreaterThanOrEqual(0.9)
  }, 60000)

  it('names a smooth lead and still refuses drums and noise', () => {
    const rate = 22050
    function lead(note: number, seconds: number) {
      const data = new Float32Array(Math.round(seconds * rate))
      const freq = midiHz(note)
      for (let h = 1; h <= 8; h++) {
        const f = freq * h
        if (f >= rate * 0.45) break
        for (let i = 0; i < data.length; i++) {
          const t = i / rate
          data[i] += Math.sin(2 * Math.PI * f * t) * (0.22 / h) * Math.min(1, t / 0.06)
        }
      }
      return data
    }
    const minor = concat([69, 72, 76, 74, 72, 71, 69].map((note) => lead(note, 0.5)))
    const heard = detectKey(minor, rate)
    expect(heard.clear).toBe(true)
    expect(heard.root).toBe(9)
    expect(heard.scale).toBe('aeolian')
    const card = hearingOf(heard, { bpm: 0, confidence: 0 })
    expect(card.altConfidence).toBeLessThanOrEqual(card.confidence + 1e-9)
    const bed = new Float32Array(rate * 3)
    for (let i = 0; i < bed.length; i++) bed[i] = noise(i) * (i < rate ? 0.02 : 0.8)
    const bedKey = detectKey(bed, rate)
    expect(bedKey.clear).toBe(false)
    expect(bedKey.label).toBe('No clear key')
    expect(bedKey.best).toBeNull()
    const white = new Float32Array(rate * 3)
    let seed = 1
    for (let i = 0; i < white.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      white[i] = (seed / 2 ** 32) * 2 - 1
    }
    const whiteKey = detectKey(white, rate)
    expect(whiteKey.clear).toBe(false)
    expect(whiteKey.label).toBe('No clear key')
    expect(whiteKey.best).toBeNull()
    const brown = new Float32Array(rate * 3)
    let prev = 0
    for (let i = 0; i < brown.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const sample = (seed / 2 ** 32) * 2 - 1
      prev = prev * 0.98 + sample * 0.02
      brown[i] = prev
    }
    const brownKey = detectKey(brown, rate)
    expect(brownKey.clear).toBe(false)
    expect(brownKey.label).toBe('No clear key')
    expect(brownKey.best).toBeNull()
  })

  it('does not name a one-shot', () => {
    const rate = 22050
    const audio = progression(MAJOR_CADENCE, 0, rate, 0)
    const clip: AudioClip = {
      id: 'stab',
      name: 'Chord stab',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      soundType: 'one-shot',
      soundCategory: 'chord',
    }
    const response = handleClipDetect({
      id: 9,
      type: 'clip-detect',
      sampleRate: rate,
      channels: [audio],
      clip,
      tempo: 120,
    })
    expect(response.hearing?.clearKey).toBe(false)
    expect(response.hearing?.key).toBe('')
    expect(response.hearing?.maybeKey ?? '').toBe('')
    expect(response.hearing?.root).toBeNull()
  })

  it('does not name a drum-category clip or noise, even when the audio is tonal', () => {
    const rate = 22050
    const audio = progression(MAJOR_CADENCE, 0, rate, 0)
    for (const sound of [
      { id: 'kit', soundCategory: 'drums' },
      { id: 'hiss', soundCategory: 'noise' },
    ]) {
      const response = handleClipDetect({
        id: sound.id === 'kit' ? 10 : 11,
        type: 'clip-detect',
        sampleRate: rate,
        channels: [audio],
        clip: {
          id: sound.id,
          name: 'Groove',
          bufferId: 'buf',
          startSample: 0,
          offsetSamples: 0,
          durationSamples: audio.length,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          gain: 1,
          source: 'import',
          soundType: 'loop',
          soundCategory: sound.soundCategory,
        },
        tempo: 120,
      })
      expect(response.hearing?.clearKey).toBe(false)
      expect(response.hearing?.key).toBe('')
      expect(response.hearing?.maybeKey ?? '').toBe('')
      expect(response.hearing?.root).toBeNull()
    }
  })

  it('says there is no clear key on a drum loop', () => {
    const rate = 22050
    const heard = detectKey(drums(100, 4, rate), rate)
    expect(heard.clear).toBe(false)
    expect(heard.label).toBe('No clear key')
    expect(heard.best).toBeNull()
    expect(heard.unsure).toBeUndefined()
    const hearing = hearingOf(heard, detectTempo(drums(96, 4, rate), rate))
    expect(hearing.clearKey).toBe(false)
    expect(hearing.key).toBe('')
    expect(Math.abs(hearing.bpm - 96)).toBeLessThanOrEqual(2)
  })

  it('keeps tempo on the source and moves the key with the sounded pitch', () => {
    const rate = 22050
    const audio = progression(MAJOR_CADENCE, 0, rate, 0, 110)
    const clip: AudioClip = {
      id: 'clip',
      name: 'Loop',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: Math.round(audio.length * 110 / 140),
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: {
        sourceSamples: audio.length,
        semitones: 5,
        cents: 0,
        mode: 'pro',
        followTempo: true,
        tempoMode: 'follow',
        sourceBpm: 110,
        markers: [],
      },
    }
    const response = handleClipDetect({
      id: 3,
      type: 'clip-detect',
      sampleRate: rate,
      channels: [audio],
      clip,
      tempo: 140,
    })
    expect(response.type).toBe('result')
    expect(response.hearing?.clearKey).toBe(true)
    expect(response.hearing?.root).toBe(5)
    expect(response.hearing?.scale).toBe('ionian')
    expect(response.hearing?.key).toBe('F major')
    const heardBpm = response.hearing?.bpm ?? 0
    const nearSource = Math.abs(heardBpm - 110) <= 3 || Math.abs(heardBpm - 55) <= 3
    expect(nearSource).toBe(true)
    expect(Math.abs(heardBpm - 140)).toBeGreaterThan(3)
    expect(response.hearing?.alt).toBeTruthy()
  }, 60000)

  it('stores the reading, sets the project key, and offers the tempo without dropping Follow', () => {
    const rate = 48000
    const project = createEmptyProject(rate)
    project.tempo = 128
    const store = new ProjectStore(project)
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    const [other] = store.addTracks({ kind: 'midi', count: 1, instrument: 'none', input: 'mic', channels: 1, armed: false })
    store.addPlugin(other, 'tune')
    const tune = store.track(other)?.plugins.find((plugin) => plugin.pluginId === 'tune')
    expect(tune?.params.root).toBe(-1)
    expect(tune?.params.scaleIndex).toBe(-1)
    expect(createPlugin('tune').params.root).toBe(-1)
    const audio = new Float32Array(rate)
    const clip: AudioClip = {
      id: 'loop',
      name: 'Loop',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: Math.round(rate * 100 / 128),
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: {
        sourceSamples: rate,
        semitones: 0,
        cents: 0,
        mode: 'pro',
        followTempo: true,
        tempoMode: 'follow',
        sourceBpm: 100,
        markers: [],
      },
    }
    store.addAsset({ id: 'buf', name: 'Loop', sampleRate: rate, channels: [audio] })
    store.addAudioClip(track.id, clip)
    store.rememberClipHearing(track.id, clip.id, {
      key: 'A minor',
      root: 9,
      scale: 'aeolian',
      confidence: 0.81,
      alt: 'C major',
      altRoot: 0,
      altScale: 'ionian',
      altConfidence: 0.74,
      clearKey: true,
      bpm: 100,
      bpmConfidence: 0.7,
      cents: 12,
    })
    const saved = migrateProject(JSON.parse(JSON.stringify(store.project)))
    const kept = saved.tracks.find((item) => item.id === track.id)?.clips.find((item) => item.id === 'loop')
    expect(kept?.hearing?.key).toBe('A minor')
    expect(kept?.hearing?.bpm).toBe(100)
    store.setScale({ root: 2, scale: 'dorian', library: 'maqam-bayati' })
    expect(store.project.tempo).toBe(128)
    store.useDetectedKey(track.id, clip.id)
    expect(store.project.tempo).toBe(128)
    const scale = store.scaleState()
    expect(scale.root).toBe(9)
    expect(scale.scale).toBe('aeolian')
    expect(scale.library).toBe('')
    const song = tuneScaleOf(scale)
    expect(song).toMatchObject({ root: 9, note: 'A', scaleName: 'Minor' })
    const frame = tuneBlockScale(scale)
    const snapped = tuneSnapMidi(61, { root: -1, scaleIndex: -1, mode: 1 }, frame)
    expect(Math.round(snapped)).not.toBe(61)
    store.useDetectedTempo(track.id, clip.id)
    const live = store.track(track.id)?.clips.find((item) => item.id === 'loop')
    expect(store.project.tempo).toBe(100)
    expect(live?.stretch?.followTempo).toBe(true)
    expect(live?.stretch?.tempoMode).toBe('follow')
    expect(live?.stretch?.sourceBpm).toBe(100)
    expect(relateTempo(200, 100)).toBe('double')
    expect(tempoForSong(200, 100)).toBe(100)
    expect(tempoReadout(100, 100, 128)).toContain('matches the source')
    expect(keyReadout(live!.hearing!)).toBe('A minor · 81%')
    expect(altReadout(live!.hearing!)).toContain('C major')
  })

  it('puts Detect on the selected audio clip and keeps a stored reading in the dock', () => {
    const rate = 48000
    const idle = new ProjectStore(createEmptyProject(rate))
    const dock = (store: ProjectStore) => renderToStaticMarkup(createElement(PhoneDock, {
      store,
      place: 'arrange',
      menuOpen: false,
      browseOpen: false,
      ideasOpen: false,
      onMenu() {},
      onBrowse() {},
      onIdeas() {},
      onMenuAction() {},
      onUndo() {},
      onRedo() {},
      canUndo: false,
      canRedo: false,
      playheadSample: () => 0,
    }))
    expect(dock(idle)).not.toContain('data-clip-detect')
    const project = createEmptyProject(rate)
    const store = new ProjectStore(project)
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.addAsset({ id: 'buf', name: 'Loop', sampleRate: rate, channels: [new Float32Array(rate)] })
    store.addAudioClip(track.id, {
      id: 'loop',
      name: 'Loop',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: rate,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    })
    const open = dock(store)
    expect(open).toContain('data-clip-detect')
    expect(open).toContain('Detect')
    expect(open).not.toContain('data-clip-hearing')
    store.rememberClipHearing(track.id, 'loop', {
      key: 'D major',
      root: 2,
      scale: 'ionian',
      confidence: 0.77,
      alt: 'B minor',
      altRoot: 11,
      altScale: 'aeolian',
      altConfidence: 0.61,
      clearKey: true,
      bpm: 96,
      bpmConfidence: 0.8,
      cents: 0,
    })
    const card = dock(store)
    expect(card).toContain('data-clip-hearing')
    expect(card).toContain('D major')
    expect(card).toContain('B minor')
    expect(card).toContain('Set song key to D major')
    expect(card).toContain('Scale: major')
    expect(card).not.toContain('Use for song')
    expect(card).not.toContain('Set song tempo')
    expect(card).not.toContain('data-hearing-bpm')
    store.rememberClipHearing(track.id, 'loop', {
      key: '',
      root: null,
      scale: '',
      confidence: 0.4,
      alt: '',
      altRoot: null,
      altScale: '',
      altConfidence: 0,
      clearKey: false,
      maybeKey: 'E minor',
      bpm: 0,
      bpmConfidence: 0,
      cents: 0,
    })
    const unsure = dock(store)
    expect(unsure).toContain('Unsure')
    expect(unsure).toContain('maybe E minor')
    expect(unsure).toContain('data-hearing-unsure')
    expect(unsure).not.toContain('Set song key to E minor')
    store.rememberClipHearing(track.id, 'loop', {
      key: '',
      root: null,
      scale: '',
      confidence: 0,
      alt: '',
      altRoot: null,
      altScale: '',
      altConfidence: 0,
      clearKey: false,
      maybeKey: '',
      bpm: 96,
      bpmConfidence: 0.8,
      cents: 0,
    })
    const unnamed = dock(store)
    expect(unnamed).toContain('No clear key')
    expect(unnamed).not.toContain('maybe')
    expect(unnamed).not.toContain('Set song key')
    expect(unnamed).not.toContain('data-hearing-bpm')
    store.selectClip(track.id, null)
    expect(dock(store)).not.toContain('data-clip-detect')
    const worker = readFileSync('src/analysis/clipWorker.ts', 'utf8')
    const job = readFileSync('src/analysis/clipJob.ts', 'utf8')
    expect(worker).toContain('handleClipDetect')
    expect(job).toContain('new Worker')
    expect(worker).not.toContain('huggingface')
    expect(worker).not.toContain('onnxruntime')
  })
})
