import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { heardBeat } from '../model/midiClock'
import { defaultRoll, quantizeNotes, arpeggiateSelection, humanizeNotes, snapBeat, strumSelection } from '../model/paint'
import {
  NOTE_NAMES,
  SCALES,
  diatonicPads,
  detectKey,
  inScale,
  nameChord,
  noteName,
  scaleTones,
  snapPitch,
  voiceChord,
  type ArpDirection,
  type ChordSource,
  type RhythmPattern,
  type ScaleId,
} from '../model/scale'
import { uid, type MidiNote } from '../model/types'
import { EDITOR_TOOLS, EDITOR_TOOL_KEYS, activeTool, keyForTool, setActiveTool, subscribeTools } from '../state/tools'
import type { ProjectStore } from '../state/store'
import { samplesToBeats } from '../model/time'
import { attachGlissando } from './glissando'
import {
  commitMidiNotes,
  duplicateNotes,
  forkNotes,
  hitNote,
  moveNotes,
  notesInRect,
  paintVelocity,
  pencilNote,
  pinchZoom,
  resizeNote,
  splitNotes,
  withoutNotes,
} from './pianoEdit'

const SOURCES: { id: ChordSource; name: string }[] = [
  { id: 'triads', name: 'Triads' },
  { id: 'sevenths', name: '7ths' },
  { id: 'ninths', name: '9ths' },
  { id: 'sus', name: 'Sus' },
  { id: 'add', name: 'Add' },
  { id: 'borrowed', name: 'Borrowed' },
  { id: 'secondary', name: 'Secondary' },
  { id: 'pop', name: 'Pop' },
  { id: 'rnb', name: 'R&B' },
  { id: 'edm', name: 'EDM' },
  { id: 'cinematic', name: 'Film' },
  { id: 'rock', name: 'Rock' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'gospel', name: 'Gospel' },
]

const LOW = 48
const HIGH = 84
const VEL_H = 36

export function PianoRoll({ store, engine, onIdeas, onGenerate }: { store: ProjectStore; engine: AudioEngine; onIdeas?: () => void; onGenerate?: () => void }) {
  const track = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
  const clip = track?.midiClips.find((item) => item.id === store.selectedMidiClipId)
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState(16)
  const [pxBeat, setPxBeat] = useState(70)
  const [ghost, setGhost] = useState<MidiNote[] | null>(null)
  const [box, setBox] = useState<{ a: number; b: number; p0: number; p1: number } | null>(null)
  const [viewRev, setViewRev] = useState(0)
  const rowRef = useRef(row)
  const pxRef = useRef(pxBeat)
  rowRef.current = row
  pxRef.current = pxBeat
  const rollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pianoRef = useRef<HTMLDivElement>(null)
  const keysRef = useRef<HTMLDivElement>(null)
  const velRef = useRef<HTMLDivElement>(null)
  const dragGen = useRef(0)
  const multi = useRef(false)
  const frameRef = useRef<{ originPx: number; originRow: number; contentX: number; contentY: number; clientX: number; clientY: number } | null>(null)
  const fingers = useRef(new Map<number, { pitch: number; eventMs: number; velocity: number }>())
  const playKey = useRef<(pitch: number, event: { timeStamp: number }, pointerId: number, on: boolean, velocity?: number) => void>(() => {})
  const tool = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const api = useRef<{ quantize: () => boolean; arpeggiate: () => void; strum: () => void; humanize: () => void; duplicate: () => boolean; remove: () => boolean }>({
    quantize: () => false,
    arpeggiate: () => {},
    strum: () => {},
    humanize: () => {},
    duplicate: () => false,
    remove: () => false,
  })

  function cell(event: { clientX: number; clientY: number }) {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      beat: Math.max(0, (event.clientX - rect.left) / Math.max(1, pxRef.current)),
      pitch: HIGH - Math.floor((event.clientY - rect.top) / Math.max(1, rowRef.current)),
    }
  }

  function watch(gen: number, move: (event: PointerEvent) => void, up: (event: PointerEvent) => void) {
    const onMove = (event: PointerEvent) => {
      if (dragGen.current !== gen) return
      move(event)
    }
    const onUp = (event: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (dragGen.current !== gen) return
      up(event)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function selectIds(ids: string[], additive: boolean) {
    if (!ids.length) {
      if (!additive) store.selectNote(null)
      return
    }
    if (!additive) {
      store.selectNote(ids[0])
      for (const id of ids.slice(1)) store.selectNote(id, true)
      return
    }
    for (const id of ids) {
      if (!store.selectedNoteIds.includes(id)) store.selectNote(id, true)
    }
  }

  useLayoutEffect(() => {
    const frame = frameRef.current
    const view = rollRef.current
    if (!frame || !view) return
    const rect = view.getBoundingClientRect()
    view.scrollLeft = frame.contentX * (pxRef.current / Math.max(1, frame.originPx)) - (frame.clientX - rect.left)
    view.scrollTop = frame.contentY * (rowRef.current / Math.max(1, frame.originRow)) - (frame.clientY - rect.top)
    if (keysRef.current) keysRef.current.scrollTop = view.scrollTop
    if (velRef.current) velRef.current.scrollLeft = view.scrollLeft
  }, [viewRev])

  useEffect(() => {
    const el = rollRef.current
    if (!el) return
    let start: { dist: number; px: number; row: number; contentX: number; contentY: number } | null = null
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const centroid = (touches: TouchList) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    })
    const begin = (event: TouchEvent) => {
      if (event.touches.length < 2) return
      multi.current = true
      dragGen.current += 1
      setGhost(null)
      setBox(null)
      const point = centroid(event.touches)
      const rect = el.getBoundingClientRect()
      start = {
        dist: Math.max(1, distance(event.touches)),
        px: pxRef.current,
        row: rowRef.current,
        contentX: point.x - rect.left + el.scrollLeft,
        contentY: point.y - rect.top + el.scrollTop,
      }
    }
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !start) return
      event.preventDefault()
      const point = centroid(event.touches)
      const next = pinchZoom(start.px, start.row, distance(event.touches) / start.dist)
      frameRef.current = {
        originPx: start.px,
        originRow: start.row,
        contentX: start.contentX,
        contentY: start.contentY,
        clientX: point.x,
        clientY: point.y,
      }
      setPxBeat(next.pxBeat)
      setRow(next.row)
      setViewRev((value) => value + 1)
    }
    const end = (event: TouchEvent) => {
      if (event.touches.length >= 2) return
      start = null
      multi.current = false
    }
    el.addEventListener('touchstart', begin, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', begin)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [clip?.id])

  const midiRef = useRef<MIDIAccess | null>(null)
  const scale = store.scaleState()
  const roll = store.project.roll ?? defaultRoll()

  useEffect(() => {
    if (!navigator.requestMIDIAccess) return
    let dead = false
    const held = new Map<number, number>()
    void navigator.requestMIDIAccess().then((access) => {
      if (dead) return
      midiRef.current = access
      const bind = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (event) => {
            const data = event.data
            if (!data || data.length < 3) return
            const status = data[0] & 0xf0
            const pitch = data[1]
            const velocity = data[2]
            const on = status === 0x90 && velocity > 0
            const off = status === 0x80 || (status === 0x90 && velocity === 0)
            if (!on && !off) return
            const id = 3000 + pitch
            const stamp = { timeStamp: event.timeStamp }
            if (on) {
              if (held.has(pitch)) return
              held.set(pitch, id)
              playKey.current(pitch, stamp, id, true, velocity / 127)
            } else if (held.has(pitch)) {
              held.delete(pitch)
              playKey.current(pitch, stamp, id, false)
            }
          }
        }
      }
      bind()
      access.onstatechange = bind
    }).catch(() => undefined)
    return () => {
      dead = true
      const now = performance.now()
      for (const [pitch, id] of held) playKey.current(pitch, { timeStamp: now }, id, false)
      held.clear()
      const access = midiRef.current
      if (!access) return
      access.onstatechange = null
      for (const input of access.inputs.values()) input.onmidimessage = null
    }
  }, [])

  playKey.current = (pitch, event, pointerId, on, velocity = 0.8) => {
    if (!track || !clip) return
    if (on) {
      const current = store.scaleState()
      const next = current.snap ? snapPitch(pitch, current.root, current.scale) : pitch
      const level = Math.max(0.05, Math.min(1, velocity))
      engine.unlock()
      void engine.resume()
      engine.liveNoteOn(next, level)
      fingers.current.set(pointerId, { pitch: next, eventMs: event.timeStamp, velocity: level })
      return
    }
    const held = fingers.current.get(pointerId)
    fingers.current.delete(pointerId)
    if (!held) return
    const still = [...fingers.current.values()].some((item) => item.pitch === held.pitch)
    if (!still) engine.liveNoteOff(held.pitch)
    const playing = engine.status === 'playing' || engine.status === 'recording'
    const start = playing ? performanceBeat(store, engine, held.eventMs) : timelineBeat(store, engine)
    const end = playing ? performanceBeat(store, engine, event.timeStamp) : start
    const elapsed = Math.max(0, event.timeStamp - held.eventMs) / 1000 * (store.project.tempo / 60)
    const duration = playing ? Math.max(0.05, end - start) : Math.max(0.05, elapsed)
    store.addNote(track.id, clip.id, {
      pitch: held.pitch,
      startBeat: Math.max(0, start - clip.startBeat),
      durationBeats: duration,
      velocity: held.velocity,
    })
  }

  useEffect(() => {
    const root = pianoRef.current
    const keys = keysRef.current
    const rollNode = rollRef.current
    if (!root) return
    const detach = attachGlissando(root, {
      accept: (key) => !!key.closest('.keys, .scale-keys'),
      onOn: (pitch, event, pointerId) => playKey.current(pitch, event, pointerId, true),
      onOff: (pitch, event, pointerId) => playKey.current(pitch, event, pointerId, false),
      onTwoFinger: (dy) => {
        if (!keys) return
        keys.scrollTop -= dy
        if (rollNode) rollNode.scrollTop = keys.scrollTop
      },
    })
    const sync = () => {
      if (keys && rollNode && keys.scrollTop !== rollNode.scrollTop) keys.scrollTop = rollNode.scrollTop
      if (velRef.current && rollNode) velRef.current.scrollLeft = rollNode.scrollLeft
    }
    rollNode?.addEventListener('scroll', sync)
    return () => {
      rollNode?.removeEventListener('scroll', sync)
      detach()
    }
  }, [clip?.id])

  useEffect(() => {
    const codes: Record<string, number> = {
      KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65,
      KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71,
    }
    const letters: Record<string, number> = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71 }
    const held = new Map<string, number>()
    let nextId = 4000
    const tokenOf = (event: KeyboardEvent) => event.code || event.key
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const token = tokenOf(event)
      if (held.has(token)) return
      const pitch = codes[event.code] ?? letters[event.key.toLowerCase()]
      if (pitch == null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const id = nextId++
      held.set(token, id)
      playKey.current(pitch, event, id, true)
    }
    const up = (event: KeyboardEvent) => {
      const id = held.get(tokenOf(event))
      if (id == null) return
      held.delete(tokenOf(event))
      playKey.current(0, event, id, false)
    }
    const blur = () => {
      for (const id of held.values()) playKey.current(0, { timeStamp: performance.now() }, id, false)
      held.clear()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      blur()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  function quantize() {
    if (!track || !clip) return false
    const grid = (store.project.roll ?? defaultRoll()).grid
    const ids = store.selectedNoteIds.length ? store.selectedNoteIds : undefined
    commitMidiNotes(store, track.id, clip.id, quantizeNotes(clip.notes, grid, ids).map((note) => ({ ...note, id: note.id || uid('note') })))
    return true
  }

  function arpeggiate() {
    if (!track || !clip) return
    const current = store.scaleState()
    const chosen = clip.notes.filter((note) => !store.selectedNoteIds.length || store.selectedNoteIds.includes(note.id))
    const rest = store.selectedNoteIds.length ? clip.notes.filter((note) => !store.selectedNoteIds.includes(note.id)) : []
    const played = arpeggiateSelection(chosen, { arp: current.arp, rate: current.rate, gate: current.gate, octaves: current.octaves, timing: current.timing, velocity: current.velocity })
    commitMidiNotes(store, track.id, clip.id, [...rest, ...played.map((note) => ({ ...note, id: uid('note') }))])
  }

  function strum() {
    if (!track || !clip) return
    const chosen = clip.notes.filter((note) => !store.selectedNoteIds.length || store.selectedNoteIds.includes(note.id))
    const rest = store.selectedNoteIds.length ? clip.notes.filter((note) => !store.selectedNoteIds.includes(note.id)) : []
    commitMidiNotes(store, track.id, clip.id, [...rest, ...strumSelection(chosen).map((note) => ({ ...note, id: uid('note') }))])
  }

  function humanize() {
    if (!track || !clip) return
    const current = store.scaleState()
    const chosen = clip.notes.filter((note) => !store.selectedNoteIds.length || store.selectedNoteIds.includes(note.id))
    const rest = store.selectedNoteIds.length ? clip.notes.filter((note) => !store.selectedNoteIds.includes(note.id)) : []
    commitMidiNotes(store, track.id, clip.id, [...rest, ...humanizeNotes(chosen, current.timing || 0.02, current.velocity || 0.3)])
  }

  function duplicate() {
    if (!track || !clip) return false
    const ids = store.selectedNoteIds.filter((id) => clip.notes.some((note) => note.id === id))
    if (!ids.length) return false
    const grid = (store.project.roll ?? defaultRoll()).grid
    const next = duplicateNotes(clip.notes, ids, grid, () => uid('note'))
    commitMidiNotes(store, track.id, clip.id, next.notes)
    if (!next.copyIds.length) return false
    store.selectNote(next.copyIds[0])
    for (const id of next.copyIds.slice(1)) store.selectNote(id, true)
    return true
  }

  function remove() {
    if (!track || !clip) return false
    const ids = store.selectedNoteIds.filter((id) => clip.notes.some((note) => note.id === id))
    if (!ids.length) return false
    commitMidiNotes(store, track.id, clip.id, withoutNotes(clip.notes, ids))
    store.selectNote(null)
    return true
  }

  api.current = { quantize, arpeggiate, strum, humanize, duplicate, remove }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const key = event.key.toLowerCase()
      const meta = event.metaKey || event.ctrlKey
      if (meta) {
        if (key === 'd' && api.current.duplicate()) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        return
      }
      const nextTool = EDITOR_TOOL_KEYS[event.key]
      if (nextTool) {
        setActiveTool(nextTool)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (api.current.remove()) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        return
      }
      if (key === 'q' && api.current.quantize()) event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!track || !clip) return null
  const shown = store.quantizePreview?.notes.find((item) => item.clipId === clip.id)?.notes ?? clip.notes
  const notes = ghost ?? shown
  const span = Math.max(clip.durationBeats, 8, ...notes.map((note) => note.startBeat + note.durationBeats + 1))
  const width = span * pxBeat
  const selected = notes.filter((note) => store.selectedNoteIds.includes(note.id))
  const chord = selected.length ? nameChord(selected.map((note) => note.pitch)) : ''
  const pads = diatonicPads(scale.root, scale.scale, scale.source)
  const tones = [...scaleTones(scale.root, scale.scale, 4), ...scaleTones(scale.root, scale.scale, 5)]
  const cursor = tool === 'pan' ? 'grab' : tool === 'zoom' ? 'zoom-in' : tool === 'select' ? 'default' : 'crosshair'

  const onGridDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || multi.current) return
    const at = cell(event)
    if (!at) return
    const grid = roll.grid
    const velocity = roll.velocity || 0.8
    const scaleNow = store.scaleState()
    const base = clip.notes.map((note) => ({ ...note }))
    event.preventDefault()

    if (tool === 'pan') {
      const view = rollRef.current
      if (!view) return
      const gen = ++dragGen.current
      const originX = event.clientX
      const originY = event.clientY
      const left = view.scrollLeft
      const top = view.scrollTop
      watch(gen, (ev) => {
        view.scrollLeft = left - (ev.clientX - originX)
        view.scrollTop = top - (ev.clientY - originY)
      }, () => {})
      return
    }

    if (tool === 'zoom') {
      const view = rollRef.current
      if (!view) return
      const gen = ++dragGen.current
      const originY = event.clientY
      const originPx = pxRef.current
      const originRow = rowRef.current
      const rect = view.getBoundingClientRect()
      const contentX = event.clientX - rect.left + view.scrollLeft
      const contentY = event.clientY - rect.top + view.scrollTop
      watch(gen, (ev) => {
        const next = pinchZoom(originPx, originRow, Math.exp((originY - ev.clientY) / 180))
        frameRef.current = { originPx, originRow, contentX, contentY, clientX: ev.clientX, clientY: ev.clientY }
        setPxBeat(next.pxBeat)
        setRow(next.row)
        setViewRev((value) => value + 1)
      }, () => {})
      return
    }

    if (tool === 'pencil') {
      const gen = ++dragGen.current
      const pitch = scaleNow.snap ? snapPitch(at.pitch, scaleNow.root, scaleNow.scale) : at.pitch
      let drawn = pencilNote(at.beat, at.beat, pitch, grid, velocity, '__pencil__')
      setGhost([...base, drawn])
      watch(gen, (ev) => {
        const point = cell(ev)
        if (!point) return
        drawn = pencilNote(at.beat, point.beat, pitch, grid, velocity, '__pencil__')
        setGhost([...base, drawn])
      }, () => {
        setGhost(null)
        store.addNote(track.id, clip.id, {
          pitch: drawn.pitch,
          startBeat: drawn.startBeat,
          durationBeats: drawn.durationBeats,
          velocity: drawn.velocity,
        })
      })
      return
    }

    if (tool === 'box') {
      const gen = ++dragGen.current
      const additive = event.shiftKey || event.metaKey
      const originX = event.clientX
      const originY = event.clientY
      let beat = at.beat
      let pitch = at.pitch
      setBox({ a: at.beat, b: at.beat, p0: at.pitch, p1: at.pitch })
      watch(gen, (ev) => {
        const point = cell(ev)
        if (!point) return
        beat = point.beat
        pitch = point.pitch
        setBox({ a: at.beat, b: beat, p0: at.pitch, p1: pitch })
      }, (ev) => {
        setBox(null)
        if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < 3) {
          const hit = hitNote(base, at.beat, at.pitch)
          if (hit) store.selectNote(hit.id, additive)
          else if (!additive) store.selectNote(null)
          return
        }
        selectIds(notesInRect(base, at.beat, beat, at.pitch, pitch), additive)
      })
      return
    }

    if (tool === 'erase') {
      const gen = ++dragGen.current
      const ids: string[] = []
      const take = (ev: { clientX: number; clientY: number }) => {
        const point = cell(ev)
        if (!point) return
        const hit = hitNote(base, point.beat, point.pitch)
        if (!hit || ids.includes(hit.id)) return
        ids.push(hit.id)
        setGhost(withoutNotes(base, ids))
      }
      take(event)
      watch(gen, take, () => {
        setGhost(null)
        if (ids.length) commitMidiNotes(store, track.id, clip.id, withoutNotes(base, ids))
      })
      return
    }

    if (tool === 'split') {
      const hit = hitNote(base, at.beat, at.pitch)
      if (!hit) return
      const created = uid('note')
      const next = splitNotes(base, hit.id, snapBeat(at.beat, grid), created)
      if (!next) return
      commitMidiNotes(store, track.id, clip.id, next)
      store.selectNote(created)
      return
    }

    if (!(event.target as HTMLElement).closest('.note')) store.selectNote(null)
  }

  const onNoteDown = (event: ReactPointerEvent<HTMLDivElement>, note: MidiNote) => {
    if (tool !== 'select') return
    event.stopPropagation()
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const grip = Math.min(8, bounds.width * 0.25)
    if (x <= grip || x >= bounds.width - grip) {
      onResize(event, note, x <= grip ? 'start' : 'end')
      return
    }
    const additive = event.shiftKey || event.metaKey
    const selected = store.selectedNoteIds.includes(note.id)
    if (additive && !event.altKey) {
      store.selectNote(note.id, true)
      if (selected) return
    } else if (!selected) store.selectNote(note.id)
    const gen = ++dragGen.current
    let moving = [...store.selectedNoteIds]
    let base = clip.notes.map((item) => ({ ...item }))
    let copyIds: string[] = []
    if (event.altKey) {
      const forked = forkNotes(base, moving, () => uid('note'))
      base = forked.notes
      moving = forked.copyIds
      copyIds = forked.copyIds
      setGhost(base)
    }
    const originX = event.clientX
    const originY = event.clientY
    const grid = roll.grid
    const scaleNow = store.scaleState()
    const pitchSnap = scaleNow.snap ? (pitch: number) => snapPitch(pitch, scaleNow.root, scaleNow.scale) : undefined
    let latest = base
    let dirty = false
    watch(gen, (ev) => {
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < 3) return
      dirty = true
      latest = moveNotes(base, moving, (ev.clientX - originX) / pxRef.current, (originY - ev.clientY) / rowRef.current, grid, pitchSnap)
      setGhost(latest)
    }, () => {
      setGhost(null)
      if (!dirty) {
        if (!event.altKey && !additive) store.selectNote(note.id)
        return
      }
      commitMidiNotes(store, track.id, clip.id, latest)
      if (!copyIds.length) return
      store.selectNote(copyIds[0])
      for (const id of copyIds.slice(1)) store.selectNote(id, true)
    })
  }

  const onResize = (event: ReactPointerEvent<HTMLDivElement>, note: MidiNote, edge: 'start' | 'end') => {
    event.stopPropagation()
    event.preventDefault()
    if (!store.selectedNoteIds.includes(note.id)) store.selectNote(note.id)
    const gen = ++dragGen.current
    const base = clip.notes.map((item) => ({ ...item }))
    const grid = roll.grid
    let latest = base
    let dirty = false
    watch(gen, (ev) => {
      const point = cell(ev)
      if (!point) return
      const source = base.find((item) => item.id === note.id)
      if (!source) return
      dirty = true
      latest = base.map((item) => (item.id === note.id ? resizeNote(source, edge, point.beat, grid) : item))
      setGhost(latest)
    }, () => {
      setGhost(null)
      if (dirty) commitMidiNotes(store, track.id, clip.id, latest)
    })
  }

  const onVelocity = (event: ReactPointerEvent<HTMLDivElement>, note: MidiNote) => {
    event.stopPropagation()
    event.preventDefault()
    const gen = ++dragGen.current
    const selectedIds = store.selectedNoteIds.filter((id) => clip.notes.some((item) => item.id === id))
    const ids = selectedIds.includes(note.id) ? selectedIds : [note.id]
    const base = clip.notes.map((item) => ({ ...item }))
    const lane = event.currentTarget
    let latest = base
    const apply = (clientY: number) => {
      const rect = lane.getBoundingClientRect()
      latest = paintVelocity(base, ids, 1 - (clientY - rect.top) / Math.max(1, rect.height))
      setGhost(latest)
    }
    apply(event.clientY)
    watch(gen, (ev) => apply(ev.clientY), () => {
      setGhost(null)
      if (latest.some((item, index) => item.velocity !== base[index]?.velocity)) commitMidiNotes(store, track.id, clip.id, latest)
    })
  }

  function toggleChords() {
    setOpen((value) => !value)
  }

  const gridPx = (roll.grid > 0 ? roll.grid : 1) * pxBeat
  return (
    <div className="piano" ref={pianoRef} data-tool={tool}>
      <div className="scale-bar">
        <button type="button" className={`chords-btn ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => void toggleChords()}>Chords</button>
        <select aria-label="Key" value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
          {NOTE_NAMES.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <select aria-label="Scale" value={scale.scale} onChange={(event) => store.setScale({ scale: event.target.value as ScaleId })}>
          {SCALES.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <button type="button" className={scale.snap ? 'on' : ''} aria-pressed={scale.snap} onClick={() => store.setScale({ snap: !scale.snap })}>Snap</button>
        <button type="button" onClick={() => {
          const found = detectKey(clip.notes.map((note) => ({ pitch: note.pitch, weight: note.durationBeats })))
          store.setScale({ root: found.root, scale: found.scale })
        }}>Detect</button>
        <span className="chord-name">{chord}</span>
        {onIdeas && <button type="button" onClick={onIdeas}>Ideas</button>}
        {onGenerate && <button type="button" onClick={onGenerate}>Generate</button>}
        {store.selectedNoteId && (
          <button
            type="button"
            className={clip.notes.find((note) => note.id === store.selectedNoteId)?.slide ? 'on' : ''}
            onClick={() => {
              const note = clip.notes.find((item) => item.id === store.selectedNoteId)
              if (note) store.updateNote(track.id, clip.id, note.id, { slide: !note.slide })
            }}
          >
            {clip.notes.find((note) => note.id === store.selectedNoteId)?.slide ? 'Slide on' : 'Slide'}
          </button>
        )}
      </div>
      <div className="tool-row">
        {EDITOR_TOOLS.map((item) => (
          <button key={item} type="button" className={tool === item ? 'on' : ''} aria-pressed={tool === item} title={`${item} (${keyForTool(item)})`} onClick={() => setActiveTool(item)}>{item}</button>
        ))}
        <select aria-label="Grid" value={String(roll.grid)} onChange={(event) => store.setRoll({ grid: Number(event.target.value) })}>
          <option value="0">Free</option>
          <option value="0.25">1/16</option>
          <option value="0.5">1/8</option>
          <option value="1">1/4</option>
        </select>
        <button type="button" onClick={quantize}>Quantize</button>
        <button type="button" onClick={arpeggiate}>Arp</button>
        <button type="button" onClick={strum}>Strum</button>
        <button type="button" onClick={duplicate}>Duplicate</button>
        <button type="button" onClick={remove}>Delete</button>
      </div>
      <div className="piano-body">
        <div className="keys" ref={keysRef}>
          {Array.from({ length: HIGH - LOW + 1 }, (_, index) => {
            const pitch = HIGH - index
            const black = [1, 3, 6, 8, 10].includes(pitch % 12)
            return (
              <div key={pitch} data-pitch={pitch} className={`key ${black ? 'black' : ''} ${inScale(pitch, scale.root, scale.scale) ? 'in' : ''}`} style={{ height: row }}>
                {pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}
              </div>
            )
          })}
          <div style={{ height: VEL_H }} />
        </div>
        <div
          className="key-scroll"
          data-scroll="keys"
          aria-label="Scroll keyboard"
          onPointerDown={(event) => {
            event.stopPropagation()
            event.preventDefault()
            const trackNode = event.currentTarget
            const move = (ev: PointerEvent) => {
              const bounds = trackNode.getBoundingClientRect()
              const ratio = Math.min(1, Math.max(0, (ev.clientY - bounds.top) / Math.max(1, bounds.height)))
              const keys = keysRef.current
              const view = rollRef.current
              if (!keys) return
              keys.scrollTop = ratio * Math.max(0, keys.scrollHeight - keys.clientHeight)
              if (view) view.scrollTop = keys.scrollTop
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              window.removeEventListener('pointercancel', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
            window.addEventListener('pointercancel', up)
            move(event.nativeEvent)
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <div className="roll" ref={rollRef} style={{ flex: 1, minHeight: 0, touchAction: 'none' }}>
            <div
              ref={gridRef}
              style={{
                width,
                height: (HIGH - LOW + 1) * row,
                position: 'relative',
                touchAction: 'none',
                cursor,
                backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)',
                backgroundSize: `${gridPx}px ${row}px`,
              }}
              onPointerDown={onGridDown}
            >
              {Array.from({ length: HIGH - LOW + 1 }, (_, index) => {
                const pitch = HIGH - index
                if (![1, 3, 6, 8, 10].includes(pitch % 12)) return null
                return <div key={pitch} style={{ position: 'absolute', left: 0, right: 0, top: index * row, height: row, background: 'rgba(0,0,0,0.18)', pointerEvents: 'none' }} />
              })}
              {notes.map((note) => {
                const noteWidth = Math.max(8, note.durationBeats * pxBeat)
                return (
                  <div
                    key={note.id}
                    data-note={note.id}
                    className={`note ${store.selectedNoteIds.includes(note.id) ? 'selected' : ''} ${inScale(note.pitch, scale.root, scale.scale) ? '' : 'off'} ${note.slide ? 'slide' : ''}`}
                    style={{ left: note.startBeat * pxBeat, width: noteWidth, top: (HIGH - note.pitch) * row, height: Math.max(12, row - 2), cursor: tool === 'select' ? 'grab' : 'inherit' }}
                    onPointerMove={(event) => {
                      if (tool !== 'select') return
                      const bounds = event.currentTarget.getBoundingClientRect()
                      const x = event.clientX - bounds.left
                      const zone = Math.min(8, bounds.width * 0.25)
                      event.currentTarget.style.cursor = x <= zone || x >= bounds.width - zone ? 'ew-resize' : 'grab'
                    }}
                    onPointerDown={(event) => onNoteDown(event, note)}
                  />
                )
              })}
              {box && (
                <div
                  style={{
                    position: 'absolute',
                    left: Math.min(box.a, box.b) * pxBeat,
                    width: Math.max(1, Math.abs(box.b - box.a) * pxBeat),
                    top: (HIGH - Math.max(box.p0, box.p1)) * row,
                    height: (Math.abs(box.p1 - box.p0) + 1) * row,
                    background: 'rgba(115, 196, 143, 0.22)',
                    border: '1px solid var(--accent)',
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
          </div>
          <div ref={velRef} aria-label="Velocity" style={{ flex: 'none', height: VEL_H, overflow: 'hidden', borderTop: '1px solid var(--line)', background: '#0c110f' }}>
            <div style={{ width, height: '100%', position: 'relative' }}>
              {notes.map((note) => (
                <div
                  key={note.id}
                  title="Velocity"
                  style={{ position: 'absolute', left: note.startBeat * pxBeat, width: Math.max(4, note.durationBeats * pxBeat), top: 0, bottom: 0, touchAction: 'none' }}
                  onPointerDown={(event) => onVelocity(event, note)}
                >
                  <i style={{ position: 'absolute', display: 'block', left: 1, right: 1, bottom: 0, height: `${Math.max(8, note.velocity * 100)}%`, background: store.selectedNoteIds.includes(note.id) ? 'var(--accent)' : 'var(--blue)', opacity: 0.9, pointerEvents: 'none' }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {open && (
        <div className="chord-sheet">
          <div className="chord-top">
            <select aria-label="Chord set" value={scale.source} onChange={(event) => store.setScale({ source: event.target.value as ChordSource })}>
              {SOURCES.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="chord-pads">
            {pads.map((pad, index) => (
              <button key={`${pad.label}-${index}`} type="button" onClick={() => playPadNotes(store, engine, track.id, clip.id, pad.pitches)}>{pad.label}</button>
            ))}
          </div>
          <div className="scale-keys">
            {tones.map((pitch) => (
              <button key={pitch} type="button" data-pitch={pitch}>
                {noteName(pitch)}{Math.floor(pitch / 12) - 1}
              </button>
            ))}
          </div>
          <details className="chord-depth">
            <summary>More</summary>
            <label>Inv
              <select aria-label="Inversion" value={scale.inversion} onChange={(event) => store.setScale({ inversion: Number(event.target.value) })}>
                {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button type="button" className={scale.spread ? 'on' : ''} onClick={() => store.setScale({ spread: !scale.spread })}>Spread</button>
            <button type="button" className={scale.drop2 ? 'on' : ''} onClick={() => store.setScale({ drop2: !scale.drop2 })}>Drop2</button>
            <button type="button" className={scale.octave ? 'on' : ''} onClick={() => store.setScale({ octave: !scale.octave })}>Octave</button>
            <button type="button" className={scale.voiceLead ? 'on' : ''} onClick={() => store.setScale({ voiceLead: !scale.voiceLead })}>Lead</button>
            <select aria-label="Arp" value={scale.arp} onChange={(event) => store.setScale({ arp: event.target.value as ArpDirection })}>
              {(['off', 'up', 'down', 'upDown', 'random'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Rate" value={scale.rate} onChange={(event) => store.setScale({ rate: Number(event.target.value) })}>
              {[0.25, 0.5, 1, 2].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Gate" value={scale.gate} onChange={(event) => store.setScale({ gate: Number(event.target.value) })}>
              {[0.5, 0.8, 1].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Octaves" value={scale.octaves} onChange={(event) => store.setScale({ octaves: Number(event.target.value) })}>
              {[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Rhythm" value={scale.rhythm} onChange={(event) => store.setScale({ rhythm: event.target.value as RhythmPattern })}>
              {(['block', 'quarter', 'eighth', 'sync', 'strum'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <label>Time
              <input aria-label="Timing" type="range" min={0} max={0.2} step={0.01} value={scale.timing} onChange={(event) => store.setScale({ timing: Number(event.target.value) })} />
            </label>
            <label>Vel
              <input aria-label="Velocity" type="range" min={0} max={1} step={0.05} value={scale.velocity} onChange={(event) => store.setScale({ velocity: Number(event.target.value) })} />
            </label>
          </details>
        </div>
      )}
    </div>
  )
}

function playPadNotes(store: ProjectStore, engine: AudioEngine, trackId: string, clipId: string, pitches: number[]) {
  engine.unlock()
  const current = store.scaleState()
  const voiced = voiceChord(pitches, {
    inversion: current.inversion,
    spread: current.spread,
    drop2: current.drop2,
    octave: current.octave,
    voiceLead: current.voiceLead,
    previous: current.lastVoicing,
  })
  engine.previewPitches(voiced)
  store.insertPerformance(trackId, clipId, timelineBeat(store, engine), pitches)
}

function performanceBeat(store: ProjectStore, engine: AudioEngine, eventMs: number) {
  const origin = engine.playOrigin()
  const clock = engine.clockCompensation()
  return Math.max(0, heardBeat({
    eventMs,
    stamp: engine.outputStamp(),
    originContext: origin.context,
    originBeat: origin.beat,
    tempo: store.project.tempo,
    outputLatency: clock.outputLatency,
    baseLatency: clock.baseLatency,
    calibrationSec: clock.calibrationSec,
    quantizeBeats: 0,
  }))
}

function timelineBeat(store: ProjectStore, engine: AudioEngine) {
  const project = store.project
  let beat = samplesToBeats(engine.currentTimelineSample(), project.sampleRate, project.tempo)
  if (project.snap) beat = Math.round(beat * 4) / 4
  return Math.max(0, beat)
}
