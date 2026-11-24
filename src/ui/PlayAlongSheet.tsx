import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AudioEngine } from '../audio/engine'
import { isRecordedClip } from '../audio/recordTake'
import { DRUM_PADS } from '../model/drums'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { countInBarsOf, countInCaption, quartersPerBar } from '../model/time'
import { notesForMidi } from '../playalong/convert'
import { scoreFromMidi, scoreFromPattern } from '../playalong/fromClip'
import { transcribeInWorker, stretchInWorker } from '../playalong/job'
import { nameChord } from '../playalong/chords'
import { noteLabel, preferFlats, spellSymbol, type KeySpell } from '../playalong/names'
import { countInSecondsAt, practicePlan, type PracticePlan } from '../playalong/practice'
import { chordAt, heardTimelineSample, latencySamples, notesSounding, stepTo } from '../playalong/sync'
import type { AudioClip } from '../model/types'
import type { NameMode, PlayScore, PracticeRate } from '../playalong/types'
import type { ProjectStore } from '../state/store'
import { useProjectVersion } from './playbackUi'
import { useScreenOverlay } from './screenOverlay'
import { alongSelection } from './playAlongBus'
import { PlayAlongFace, keySpan, type AlongLaneNote, type AlongPad } from './PlayAlongFace'

const EMPTY: PlayScore = { kind: 'midi', approximate: false, confidence: 0, notes: [], chords: [], durationBeats: 4 }

function windowOf(channels: Float32Array[], fromRate: number, projectRate: number, offset: number, duration: number) {
  const scale = fromRate / Math.max(1, projectRate)
  const start = Math.max(0, Math.round(offset * scale))
  const length = Math.max(1, Math.round(duration * scale))
  return channels.map((channel) => {
    const out = new Float32Array(length)
    const end = Math.min(channel.length, start + length)
    if (end > start) out.set(channel.subarray(start, end))
    return out
  })
}

function readout(score: PlayScore, beat: number, names: NameMode, key: KeySpell | null) {
  const flats = preferFlats(key)
  if (score.kind === 'drums') {
    const on = notesSounding(score.notes, beat)
    return {
      chord: on.map((note) => note.drum || 'Hit').join(' + '),
      bass: '',
      lit: on.map((note) => note.pitch),
    }
  }
  if (score.kind === 'poly') {
    const chord = chordAt(score.chords, beat)
    return {
      chord: chord ? spellSymbol(chord.symbol, flats) : '',
      bass: chord?.bass != null ? `bass ${noteLabel(chord.bass, names, key)}` : '',
      lit: chord?.tones ?? [],
    }
  }
  const on = notesSounding(score.notes, beat)
  const named = nameChord(on.map((note) => note.pitch), key)
  if (named) {
    return { chord: spellSymbol(named.symbol, flats), bass: noteLabel(named.bass, names, key), lit: on.map((note) => note.pitch) }
  }
  if (on.length === 1) return { chord: noteLabel(on[0].pitch, names, key), bass: '', lit: [on[0].pitch] }
  return { chord: '', bass: '', lit: on.map((note) => note.pitch) }
}

function confidenceText(score: PlayScore) {
  if (!score.notes.length && !score.chords.length) return score.approximate ? 'approximate' : ''
  const pct = Math.round(Math.max(0, Math.min(1, score.confidence)) * 100)
  return score.approximate ? `${pct}% · approximate` : 'Exact'
}

export function PlayAlongSheet({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  useProjectVersion(store)
  useScreenOverlay(onClose)
  const selection = alongSelection(store)
  const track = selection ? store.track(selection.trackId) : null
  const audio = selection?.kind === 'audio' ? track?.clips.find((clip) => clip.id === selection.clipId) ?? null : null
  const midi = selection?.kind === 'midi' ? track?.midiClips.find((clip) => clip.id === selection.clipId) ?? null : null
  const pattern = selection?.kind === 'pattern' ? store.project.patternClips?.find((clip) => clip.id === selection.clipId) ?? null : null
  const [audioScore, setAudioScore] = useState<PlayScore | null>(null)
  const [status, setStatus] = useState('')
  const [speed, setSpeed] = useState<PracticeRate>(1)
  const [names, setNames] = useState<NameMode>('letters')
  const [followKey, setFollowKey] = useState(true)
  const [markA, setMarkA] = useState<number | null>(null)
  const [markB, setMarkB] = useState<number | null>(null)
  const [ui, setUi] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const beatRef = useRef(0)
  const practice = useRef<{ stop: () => void; running: boolean } | null>(null)
  const songKey: KeySpell | null = store.project.scale ? { root: store.project.scale.root, scale: store.project.scale.scale } : null
  const spellKey = followKey ? songKey : null

  const clipStart = audio
    ? projectSampleBeat(store.project, audio.startSample)
    : midi
      ? midi.startBeat
      : pattern?.startBeat ?? 0
  const patternScore = pattern ? scoreFromPattern(store.project, pattern.patternId, pattern.lengthBeats) : null
  const score = audio ? audioScore ?? { ...EMPTY, kind: 'mono' as const, approximate: true, durationBeats: 4 } : midi && track ? scoreFromMidi(track, midi) : patternScore ?? EMPTY
  const recorded = isRecordedClip(audio)

  useEffect(() => {
    practice.current?.stop()
    practice.current = null
    setSpeed(1)
    setMarkA(null)
    setMarkB(null)
    setAudioScore(null)
    setStatus('')
  }, [selection?.clipId])

  useEffect(() => {
    if (!audio) return
    const asset = store.buffers.get(audio.bufferId)
    if (!asset?.channels[0]?.length) {
      setStatus('This clip has no audio loaded.')
      setAudioScore(null)
      return
    }
    let cancel = false
    setStatus('Listening…')
    const channels = windowOf(asset.channels, asset.sampleRate, store.project.sampleRate, audio.offsetSamples, audio.durationSamples)
    const endBeat = projectSampleBeat(store.project, audio.startSample + audio.durationSamples)
    const beats = Math.max(0.25, endBeat - clipStart)
    const seconds = channels[0].length / asset.sampleRate
    const tempo = seconds > 0 ? (beats * 60) / seconds : store.project.tempo
    void transcribeInWorker({
      channels,
      sampleRate: asset.sampleRate,
      tempo,
      beats,
      numerator: store.project.timeSignature.numerator,
      denominator: store.project.timeSignature.denominator,
      key: songKey,
      name: audio.name,
      soundCategory: audio.soundCategory,
      soundRole: audio.soundRole,
      soundType: audio.soundType,
      soundTags: audio.soundTags,
      part: 'auto',
    }).then((next) => {
      if (cancel) return
      setAudioScore(next)
      setStatus(next.notes.length || next.chords.length ? '' : 'No clear notes in this clip.')
    }).catch(() => {
      if (!cancel) setStatus('Could not read this clip.')
    })
    return () => { cancel = true }
  }, [audio?.id, audio?.bufferId, audio?.offsetSamples, audio?.durationSamples, audio?.name, store.project.sampleRate, store.project.tempo, songKey?.root, songKey?.scale])

  useEffect(() => {
    const place = () => {
      const slot = document.getElementById('tool-slot')
      const gap = slot ? Math.max(64, Math.round(window.innerHeight - slot.getBoundingClientRect().top)) : 96
      rootRef.current?.style.setProperty('--along-bottom', `${gap}px`)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [ui, selection?.clipId])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const root = rootRef.current
      if (!root || !score) return
      const playing = engine.status === 'playing' || engine.status === 'recording' || engine.status === 'counting-in'
      const practiceBeat = practice.current?.running ? readPracticeBeat(engine) : null
      let local = practiceBeat
      if (local == null) {
        const sample = heardTimelineSample(engine.visualSample(), latencySamples(engine.outputLatencyMs, engine.sampleRate || 48000), playing)
        const timeline = projectSampleBeat(store.project, sample)
        local = timeline - clipStart
      }
      const looping = markA != null && markB != null && markB > markA && (store.project.loopEnabled || practice.current?.running)
      if (looping && local >= markB) local = markA + ((local - markA) % (markB - markA))
      beatRef.current = local
      const sheet = root.querySelector<HTMLElement>('.play-along-sheet')
      sheet?.style.setProperty('--beat', local.toFixed(4))
      const shown = readout(score, local, names, spellKey)
      const lit = new Set(shown.lit)
      for (const key of root.querySelectorAll<HTMLElement>('[data-key]')) {
        const pitch = Number(key.dataset.key)
        const on = lit.has(pitch)
        key.classList.toggle('lit', on)
        key.setAttribute('aria-pressed', on ? 'true' : 'false')
        const label = key.querySelector('.key-name')
        if (label) label.textContent = on ? noteLabel(pitch, names, spellKey) : ''
      }
      const chord = root.querySelector<HTMLElement>('[data-chord]')
      if (chord) {
        const text = shown.chord || (local < -0.05 ? countLabel(engine, store, speed) : '—')
        if (chord.dataset.chord !== text) {
          chord.dataset.chord = text
          const strong = chord.querySelector('b')
          if (strong) strong.textContent = text
        }
        const bass = chord.querySelector('[data-bass]')
        if (bass) bass.textContent = shown.bass
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [score, names, spellKey, speed, markA, markB, clipStart, engine, store])

  function seekLocal(local: number) {
    const sample = projectBeatSample(store.project, Math.max(0, clipStart + local))
    if (practice.current?.running) {
      practice.current.stop()
      practice.current = null
    }
    engine.seek(sample)
    beatRef.current = local
    setUi((value) => value + 1)
  }

  function onSpeed(rate: PracticeRate) {
    const plan = practicePlan(audio, rate)
    if (plan.reason) store.toast(plan.reason, 'warn')
    setSpeed(plan.rate)
    if (practice.current?.running) {
      practice.current.stop()
      practice.current = null
      setUi((value) => value + 1)
    }
  }

  function onA() {
    const beat = Math.max(0, beatRef.current)
    setMarkA((current) => (current != null && Math.abs(current - beat) < 0.04 ? null : beat))
  }

  function onB() {
    const beat = Math.max(0, beatRef.current)
    setMarkB((current) => (current != null && Math.abs(current - beat) < 0.04 ? null : beat))
  }

  function onLoop() {
    if (store.project.loopEnabled) {
      store.setLoop(false)
      return
    }
    const start = markA ?? 0
    const end = markB ?? score.durationBeats
    if (!(end > start)) {
      store.toast('Set A and B on the clip first.', 'warn')
      return
    }
    store.setLoop(true, projectBeatSample(store.project, clipStart + start), projectBeatSample(store.project, clipStart + end))
  }

  function onStep(direction: -1 | 1) {
    const notes = score.kind === 'poly'
      ? score.chords.map((chord) => ({ startBeat: chord.startBeat }))
      : score.notes
    const next = stepTo(notes, beatRef.current, direction)
    if (next == null) {
      store.toast('No notes in this clip yet.', 'warn')
      return
    }
    seekLocal(next)
  }

  function onPlay() {
    engine.unlock()
    if (practice.current?.running || engine.status === 'playing' || engine.status === 'counting-in') {
      practice.current?.stop()
      practice.current = null
      engine.stop()
      setUi((value) => value + 1)
      return
    }
    const plan = practicePlan(audio, speed)
    const from = markA ?? 0
    if (plan.stretch && audio) {
      void startPractice(audio, plan, from)
      return
    }
    if (plan.rate !== 1 && (midi || pattern)) {
      startMidiPractice(from, plan.rate)
      return
    }
    const sample = projectBeatSample(store.project, clipStart + from)
    const bars = countInBarsOf(store.project)
    if (bars > 0) {
      engine.armCountIn(
        store.project.tempo,
        store.project.timeSignature,
        bars,
      )
    }
    void engine.play(sample)
    setUi((value) => value + 1)
  }

  async function startPractice(clip: AudioClip, plan: PracticePlan, from: number) {
    const asset = store.buffers.get(clip.bufferId)
    if (!asset) {
      store.toast('This clip has no audio loaded.', 'warn')
      return
    }
    const ctx = engine.ctx ?? engine.unlock()
    const channels = windowOf(asset.channels, asset.sampleRate, store.project.sampleRate, clip.offsetSamples, clip.durationSamples)
    setStatus('Stretching…')
    const mode = score.kind === 'drums' ? 'beats' as const : 'tonal' as const
    let stretched: Float32Array[]
    try {
      stretched = await stretchInWorker(channels, asset.sampleRate, plan.rate, mode)
    } catch {
      setStatus('')
      store.toast('Could not slow this clip.', 'warn')
      return
    }
    if (!rootRef.current) return
    setStatus('')
    const buffer = ctx.createBuffer(stretched.length, stretched[0]?.length ?? 1, asset.sampleRate)
    stretched.forEach((channel, index) => buffer.getChannelData(index).set(channel))
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    source.connect(gain)
    gain.connect(ctx.destination)
    const beats = Math.max(0.25, score.durationBeats)
    const seconds = (channels[0]?.length ?? 1) / asset.sampleRate
    const tempo = seconds > 0 ? (beats * 60) / seconds : store.project.tempo
    const bars = countInBarsOf(store.project)
    const wait = countInSecondsAt(tempo, bars * quartersPerBar(store.project.timeSignature), plan.rate)
    const startAt = ctx.currentTime + 0.05 + wait
    const offset = Math.max(0, Math.min(buffer.duration - 0.01, (from / beats) * buffer.duration))
    if (markA != null && markB != null && markB > markA) {
      source.loop = true
      source.loopStart = Math.max(0, (Math.min(markA, markB) / beats) * buffer.duration)
      source.loopEnd = Math.min(buffer.duration, (Math.max(markA, markB) / beats) * buffer.duration)
    }
    source.start(startAt, offset)
    const clock = { startAt, origin: from, rate: plan.rate, tempo, running: true }
    practiceClock = clock
    const stop = () => {
      clock.running = false
      if (practiceClock === clock) practiceClock = null
      try { source.stop() } catch { /* already stopped */ }
      try { source.disconnect() } catch { /* already gone */ }
      try { gain.disconnect() } catch { /* already gone */ }
    }
    source.onended = () => {
      if (practice.current?.stop === stop) {
        practice.current = null
        setUi((value) => value + 1)
      }
    }
    practice.current = { stop, running: true }
    setUi((value) => value + 1)
  }

  function startMidiPractice(from: number, rate: PracticeRate) {
    const ctx = engine.ctx ?? engine.unlock()
    const tempo = store.project.tempo
    const bars = countInBarsOf(store.project)
    const wait = countInSecondsAt(tempo, bars * quartersPerBar(store.project.timeSignature), rate)
    const startAt = ctx.currentTime + 0.05 + wait
    const clock = { startAt, origin: from, rate, tempo, running: true }
    practiceClock = clock
    const notes = [...score.notes].sort((a, b) => a.startBeat - b.startBeat)
    let index = notes.findIndex((note) => note.startBeat >= from - 1e-3)
    if (index < 0) index = notes.length
    const held = new Set<number>()
    let timer = 0
    const stop = () => {
      clock.running = false
      if (practiceClock === clock) practiceClock = null
      window.clearInterval(timer)
      if (track) for (const pitch of held) engine.releaseThrough(track.id, pitch)
      held.clear()
    }
    timer = window.setInterval(() => {
      if (!clock.running) return
      const now = scheduleBeat(clock, ctx)
      if (now == null) return
      const loopEnd = markA != null && markB != null && markB > markA ? Math.max(markA, markB) : null
      const loopStart = loopEnd != null ? Math.min(markA ?? 0, markB ?? 0) : null
      if (loopEnd != null && loopStart != null && now >= loopEnd) {
        clock.origin = loopStart
        clock.startAt = ctx.currentTime
        index = notes.findIndex((note) => note.startBeat >= loopStart - 1e-3)
        return
      }
      while (index < notes.length && notes[index].startBeat <= now + 0.02) {
        const note = notes[index]
        index += 1
        if (!track || note.startBeat < from - 1e-3) continue
        engine.playThrough(track.id, note.pitch, note.velocity)
        held.add(note.pitch)
        const ms = Math.max(40, (note.durationBeats * 60 / tempo / rate) * 1000)
        window.setTimeout(() => {
          if (!clock.running || !track) return
          engine.releaseThrough(track.id, note.pitch)
          held.delete(note.pitch)
        }, ms)
      }
      if (index >= notes.length && (loopEnd == null)) stop()
    }, 16)
    practice.current = { stop, running: true }
    setUi((value) => value + 1)
  }

  function onConvert() {
    if (!selection || !audio) return
    if (!audioScore) {
      store.toast(status || 'Still listening to this clip.', 'warn')
      return
    }
    const notes = notesForMidi(audioScore)
    if (!notes.length) {
      store.toast('No notes to convert.', 'warn')
      return
    }
    store.convertPlayAlong(selection.trackId, selection.clipId, notes)
    store.toast('Converted to MIDI. Undo puts it back.')
  }

  function onKey(pitch: number) {
    engine.unlock()
    if (track?.type === 'midi') {
      engine.playThrough(track.id, pitch, 0.85)
      window.setTimeout(() => engine.releaseThrough(track.id, pitch), 280)
      return
    }
    const ctx = engine.ctx
    if (!ctx) return
    const hz = 440 * 2 ** ((pitch - 69) / 12)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = hz
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.38)
  }

  useEffect(() => () => {
    practice.current?.stop()
    practice.current = null
    practiceClock = null
  }, [])

  const beat = beatRef.current
  const shown = readout(score, beat, names, spellKey)
  const lane: AlongLaneNote[] = score.kind === 'poly'
    ? score.chords.map((chord, index) => ({
      id: `chord-${index}`,
      pitch: chord.bass ?? 48 + chord.root,
      startBeat: chord.startBeat,
      label: spellSymbol(chord.symbol, preferFlats(spellKey)),
      chord: true,
    }))
    : score.notes.slice(0, 400).map((note, index) => ({
      id: `${note.pitch}-${note.startBeat}-${index}`,
      pitch: note.pitch,
      startBeat: note.startBeat,
      label: note.drum || noteLabel(note.pitch, names, spellKey),
    }))
  const pitches = score.notes.map((note) => note.pitch)
  for (const chord of score.chords) pitches.push(...chord.tones)
  const span = keySpan(pitches)
  const padMap = new Map<number, string>()
  for (const note of score.notes) if (note.drum) padMap.set(note.pitch, note.drum)
  const pads: AlongPad[] = score.kind === 'drums'
    ? (padMap.size ? [...padMap].map(([pitch, name]) => ({ pitch, name })) : DRUM_PADS.slice(0, 8).map((pad) => ({ pitch: pad.pitch, name: pad.name })))
    : []
  const playing = practice.current?.running === true || engine.status === 'playing' || engine.status === 'counting-in'
  const title = audio?.name || midi?.name || pattern?.patternId || 'Clip'
  const subtitle = !selection
    ? 'Select a clip'
    : recorded
      ? 'Plays as sung'
      : score.kind === 'drums'
        ? 'Drums'
        : score.approximate
          ? 'Approximate'
          : followKey && songKey
            ? 'Song key'
            : 'MIDI'

  const face = (
    <div ref={rootRef} className="play-along-host">
      <PlayAlongFace
        title={title}
        subtitle={subtitle}
        chord={shown.chord}
        bass={shown.bass}
        confidence={audio ? confidenceText(audioScore ?? score) : confidenceText(score)}
        approximate={score.approximate}
        beat={beat}
        lane={lane}
        drums={score.kind === 'drums'}
        pads={pads}
        low={span.low}
        high={span.high}
        lit={shown.lit}
        speed={speed}
        names={names}
        followKey={followKey}
        countLabel={countInCaption(countInBarsOf(store.project))}
        countOn={countInBarsOf(store.project) > 0}
        loopOn={store.project.loopEnabled}
        markA={markA != null}
        markB={markB != null}
        canConvert={Boolean(audio)}
        playing={playing}
        status={selection ? status : 'Select a clip to play along.'}
        onClose={onClose}
        onSpeed={onSpeed}
        onNames={() => setNames((mode) => (mode === 'letters' ? 'solfege' : 'letters'))}
        onFollow={() => setFollowKey((value) => !value)}
        onCount={() => store.cycleCountIn()}
        onLoop={onLoop}
        onA={onA}
        onB={onB}
        onStep={onStep}
        onPlay={onPlay}
        onConvert={onConvert}
        onKey={onKey}
      />
    </div>
  )
  return createPortal(face, document.body)
}

interface PracticeClock {
  startAt: number
  origin: number
  rate: PracticeRate
  tempo: number
  running: boolean
}

let practiceClock: PracticeClock | null = null

function scheduleBeat(clock: PracticeClock, ctx: AudioContext) {
  if (ctx.currentTime < clock.startAt) return null
  const elapsed = ctx.currentTime - clock.startAt
  return clock.origin + (elapsed * clock.rate * clock.tempo) / 60
}

function readPracticeBeat(engine: AudioEngine) {
  const clock = practiceClock
  const ctx = engine.ctx
  if (!clock?.running || !ctx) return null
  if (ctx.currentTime < clock.startAt) return clock.origin
  const elapsed = ctx.currentTime - clock.startAt
  const beat = clock.origin + (elapsed * clock.rate * clock.tempo) / 60
  const lag = (engine.outputLatencyMs / 1000) * clock.rate * clock.tempo / 60
  return beat - lag
}

function countLabel(engine: AudioEngine, store: ProjectStore, rate: PracticeRate) {
  const clock = practiceClock
  const ctx = engine.ctx
  if (!clock?.running || !ctx || ctx.currentTime >= clock.startAt) return '—'
  const left = clock.startAt - ctx.currentTime
  const beat = (60 / Math.max(1, clock.tempo)) / rate
  const number = Math.max(1, Math.ceil(left / Math.max(0.05, beat)))
  void store
  return String(number)
}
