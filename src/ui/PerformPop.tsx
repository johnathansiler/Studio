import { useEffect, useRef, useState } from 'react'
import { Performer, pointerVelocity, type PerformTarget } from '../audio/performer'
import type { AudioEngine } from '../audio/engine'
import { DRUM_PADS, renderDrum } from '../model/drums'
import type { RepeatRate } from '../model/midiClock'
import { NOTE_NAMES, type ScaleId } from '../model/scale'
import { ScaleSelect } from './ScaleBrowser'
import { BANKS, gridPitch, PAD_MACROS, sixteenLevels, type GridLayout, type LevelSpread, type PadVoice, type StepCondition } from '../model/padMachine'
import { decodeWavPCM } from '../model/wav'
import type { ProjectStore } from '../state/store'
import type { SessionClient } from '../remote/session'
import { attachGlissando } from './glissando'

const WHITE = [0, 2, 4, 5, 7, 9, 11]
const BLACK = [1, 3, 6, 8, 10]
const KEYBOARD: Record<string, number> = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71 }
const KEY_CODES: Record<string, number> = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65,
  KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71,
}
const PAD_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV']
const DECKS = ['pads', 'steps', 'keys', 'session', 'mix'] as const
type Deck = (typeof DECKS)[number]
const RATES: RepeatRate[] = ['1/4', '1/8', '1/16', '1/32']
const MACRO_RANGE: Record<(typeof PAD_MACROS)[number], [number, number]> = {
  tune: [-12, 12],
  filter: [0, 1],
  attack: [0, 1],
  decay: [0.05, 1],
  sustain: [0, 1],
  release: [0, 1],
  pan: [-1, 1],
  level: [0, 1],
}

export function PerformPop({
  mode,
  store,
  engine,
  session,
  onRecord,
  onClose,
}: {
  mode: 'keys' | 'drums'
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onRecord: () => void
  onClose: () => void
}) {
  const drums = mode === 'drums'
  const board = useRef<HTMLDivElement>(null)
  const performer = useRef<Performer | null>(null)
  const target = useRef<PerformTarget | null>(null)
  const dragging = useRef<number | null>(null)
  const bankRef = useRef(0)
  const outputs = useRef<MIDIOutput[]>([])
  const [octave, setOctave] = useState(0)
  const [repeat, setRepeat] = useState<RepeatRate | null>(null)
  const [triplet, setTriplet] = useState(false)
  const [latency, setLatency] = useState(() => Math.round(engine.roundTripMs))
  const [focus, setFocus] = useState(engine.performanceMode)
  const [deck, setDeck] = useState<Deck>('pads')
  const [bank, setBank] = useState(0)
  const [levels, setLevels] = useState<LevelSpread | ''>('')
  const [fullLevel, setFullLevel] = useState(false)
  const [accent, setAccent] = useState(false)
  const [erase, setErase] = useState(false)
  const [latch, setLatch] = useState(false)
  const [recordMode, setRecordMode] = useState<'overdub' | 'replace'>('overdub')
  const [fixed, setFixed] = useState(0)
  const [page, setPage] = useState(0)
  const [selectedPad, setSelectedPad] = useState(0)
  const [heldStep, setHeldStep] = useState<{ pitch: number; column: number } | null>(null)
  const [ratchet, setRatchet] = useState(1)
  const [browser, setBrowser] = useState(false)
  const [layout, setLayout] = useState<GridLayout>('fourths')
  const [inKey, setInKey] = useState(true)
  const [padMutes, setPadMutes] = useState(false)
  const [soloPads, setSoloPads] = useState(false)
  const [lockParam, setLockParam] = useState('filter')
  const scale = store.scaleState()
  const record = store.recordSettings()
  const clip = currentClip(store)
  const kit = store.padProgram()
  bankRef.current = bank

  if (!performer.current) {
    performer.current = new Performer(
      engine,
      () => target.current,
      (aimed, notes, takeMode, fixedBeats) => store.addPerformedNotes(aimed.trackId, aimed.clipId, notes, takeMode, fixedBeats),
      () => engine.status === 'recording',
      (aimed, pitch, from, to) => store.erasePadNotes(aimed.trackId, aimed.clipId, pitch, from, to),
    )
  }
  performer.current.setScale(scale.snap, scale.root, scale.scale, octave)
  performer.current.setRepeat(repeat, triplet)
  performer.current.setQuantize(record.quantizeBeats || 0)
  performer.current.setDeck({
    kit: drums ? kit : null,
    swing: kit.trackSwing,
    fullLevel,
    accent,
    erase: erase && deck === 'pads',
    latch,
    levels: levels || null,
    fixedBeats: fixed,
    recordMode,
    sampleOf: (id) => store.buffers.get(id)?.channels[0] ?? null,
  })

  useEffect(() => {
    target.current = ensureTarget(store, drums)
  })

  useEffect(() => {
    engine.unlock()
    setLatency(Math.round(engine.roundTripMs))
    void engine.resume().then(async () => {
      const measured = await engine.measureLiveHit()
      setLatency(Math.round(measured.graphMs >= 0 ? measured.roundTripMs : engine.roundTripMs))
    })
    const timer = window.setInterval(() => setLatency(Math.round(engine.roundTripMs)), 1000)
    return () => window.clearInterval(timer)
  }, [engine])

  useEffect(() => {
    const root = board.current
    const play = performer.current
    if (!root || !play) return
    const detachKeys = attachGlissando(root, {
      accept: (key) => !!key.closest('.play-keys, .grid8'),
      onOn: (pitch, event, pointerId) => {
        const key = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-pitch]') as HTMLElement | null
        const level = key?.dataset.level == null ? undefined : Number(key.dataset.level)
        const rect = key?.getBoundingClientRect() ?? { top: event.clientY, height: 1 }
        play.down(pitch, pointerVelocity(event, rect), event.timeStamp, pointerId, level)
        light(outputs.current, pitch, 127)
        try { key?.setPointerCapture(pointerId) } catch { /* already released */ }
      },
      onOff: (pitch, event, pointerId) => {
        light(outputs.current, pitch, 0)
        play.up(pointerId, event.timeStamp)
      },
      onMove: (_pitch, event, pointerId) => {
        const key = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-pitch]') as HTMLElement | null
        if (!key) return
        play.pressure(pointerId, pointerVelocity(event, key.getBoundingClientRect()))
      },
      onTwoFinger: (dy) => { root.scrollTop -= dy },
    })
    const pointers = new Map<number, HTMLElement>()
    const down = (event: PointerEvent) => {
      const sample = (event.target as HTMLElement).closest?.('[data-sample]') as HTMLElement | null
      if (sample && root.contains(sample)) {
        const pitch = Number(sample.dataset.sample)
        dragging.current = pitch
        engine.liveDrum(pitch, 0.8)
        return
      }
      const key = (event.target as HTMLElement).closest?.('[data-pitch]') as HTMLElement | null
      if (key?.closest('.play-keys, .grid8')) return
      if (!key || !root.contains(key)) return
      event.preventDefault()
      const pitch = Number(key.dataset.pitch)
      const level = key.dataset.level == null ? undefined : Number(key.dataset.level)
      play.down(pitch, pointerVelocity(event, key.getBoundingClientRect()), event.timeStamp, event.pointerId, level)
      key.classList.add('lit')
      light(outputs.current, pitch, 127)
      pointers.set(event.pointerId, key)
      try { key.setPointerCapture(event.pointerId) } catch { /* already released */ }
    }
    const move = (event: PointerEvent) => {
      const key = pointers.get(event.pointerId)
      if (!key) return
      play.pressure(event.pointerId, pointerVelocity(event, key.getBoundingClientRect()))
    }
    const up = (event: PointerEvent) => {
      if (dragging.current != null) {
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-index]') as HTMLElement | null
        const samplePitch = dragging.current
        dragging.current = null
        if (hit?.dataset.index != null) store.assignResident(bankRef.current, Number(hit.dataset.index), samplePitch)
        return
      }
      const key = pointers.get(event.pointerId)
      if (!key) return
      key.classList.remove('lit')
      pointers.delete(event.pointerId)
      const pitch = Number(key.dataset.pitch)
      light(outputs.current, pitch, 0)
      play.up(event.pointerId, event.timeStamp)
      if (key.dataset.index != null) setSelectedPad(Number(key.dataset.index))
    }
    root.addEventListener('pointerdown', down, { passive: false })
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerup', up)
    root.addEventListener('pointercancel', up)
    return () => {
      detachKeys()
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerup', up)
      root.removeEventListener('pointercancel', up)
    }
  }, [drums, engine, store])

  useEffect(() => {
    const play = performer.current
    if (!play) return
    const heldKeys = new Map<string, number>()
    let nextId = 2000
    const tokenOf = (event: KeyboardEvent) => event.code || event.key
    const pitchOf = (event: KeyboardEvent) => {
      if (drums) {
        const index = PAD_CODES.indexOf(event.code)
        if (index < 0) return null
        const row = store.padProgram().banks[bankRef.current] || []
        const pad = row[index]
        if (!pad) return null
        return { pitch: levels ? (row[selectedPad]?.pitch ?? pad.pitch) : pad.pitch, level: levels ? index : undefined }
      }
      const pitch = KEY_CODES[event.code] ?? KEYBOARD[event.key.toLowerCase()]
      return pitch == null ? null : { pitch, level: undefined }
    }
    const down = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const token = tokenOf(event)
      if (heldKeys.has(token)) return
      const next = pitchOf(event)
      if (!next) return
      event.preventDefault()
      const id = nextId++
      heldKeys.set(token, id)
      play.down(next.pitch, 0.8, event.timeStamp, id, next.level)
    }
    const up = (event: KeyboardEvent) => {
      const id = heldKeys.get(tokenOf(event))
      if (id == null) return
      heldKeys.delete(tokenOf(event))
      play.up(id, event.timeStamp)
    }
    const blur = () => {
      const now = performance.now()
      for (const id of heldKeys.values()) play.up(id, now)
      heldKeys.clear()
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
  }, [drums, levels, selectedPad, store])

  useEffect(() => {
    if (!navigator.requestMIDIAccess) return
    let dead = false
    const play = performer.current
    const root = board.current
    void navigator.requestMIDIAccess().then((access) => {
      if (dead || !play) return
      const bind = () => {
        outputs.current = [...access.outputs.values()]
        for (const input of access.inputs.values()) {
          input.onmidimessage = (event) => {
            if (!event.data) return
            play.midi(event.data, event.timeStamp, window.performance.now())
            const on = (event.data[0] & 0xf0) === 0x90 && event.data[2] > 0
            root?.querySelectorAll(`[data-pitch="${event.data[1]}"]`).forEach((pad) => pad.classList.toggle('lit', on))
          }
        }
      }
      bind()
      access.onstatechange = bind
    }).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [drums])

  const base = 60
  const pads = kit.banks[bank] || []
  const source = pads[selectedPad] || pads[0]
  const showEdit = deck === 'steps' || deck === 'mix'
  const lengthSteps = clip ? Math.max(16, Math.round(clip.durationBeats * 4)) : 16
  return (
    <div className={`perform-pop ${drums ? 'drums' : 'keys'}`} role="dialog" aria-label={drums ? 'Drum machine' : 'Piano roll'}>
      <header>
        {drums ? DECKS.map((item) => (
          <button key={item} type="button" className={deck === item ? 'on' : ''} onClick={() => setDeck(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
        )) : <strong>Keys</strong>}
        <button type="button" className={engine.status === 'recording' ? 'on' : ''} onClick={() => {
          if (engine.status !== 'recording' && clip) store.armTakeUndo(clip.trackId, clip.clipId)
          onRecord()
        }}>Rec</button>
        {!drums && (
          <>
            <button type="button" onClick={() => setOctave((value) => Math.max(-3, value - 1))} aria-label="Octave down">−</button>
            <span className="octave">{NOTE_NAMES[(base + octave * 12) % 12]}{Math.floor((base + octave * 12) / 12) - 1}</span>
            <button type="button" onClick={() => setOctave((value) => Math.min(3, value + 1))} aria-label="Octave up">+</button>
            <button type="button" className={scale.snap ? 'on' : ''} onClick={() => store.setScale({ snap: !scale.snap })}>Scale</button>
            {RATES.slice(1).map((rate) => (
              <button key={rate} type="button" className={repeat === rate ? 'on' : ''} onClick={() => setRepeat((value) => (value === rate ? null : rate))}>{rate}</button>
            ))}
            <button type="button" className={triplet ? 'on' : ''} onClick={() => setTriplet((value) => !value)}>Triplet</button>
            <select aria-label="Record quantize" value={record.quantizeBeats || 0} onChange={(event) => store.setRecord({ quantizeBeats: Number(event.target.value) })}>
              <option value={0}>Quantize off</option>
              <option value={1}>1/4</option>
              <option value={0.5}>1/8</option>
              <option value={0.25}>1/16</option>
            </select>
          </>
        )}
        <button type="button" className={focus ? 'on' : ''} onClick={() => {
          const next = !engine.performanceMode
          engine.performanceMode = next
          setFocus(next)
        }}>Focus</button>
        <span className="latency" aria-label="Monitoring latency">{latency} ms</span>
        <button type="button" onClick={() => void session.calibrate()}>Calibrate</button>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      {!drums && (
        <div className="scale-row">
          <select aria-label="Key" value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
            {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <ScaleSelect value={scale.scale} onChange={(id) => store.setScale({ scale: id })} />
        </div>
      )}
      {drums && (
        <div className="tool-row">
          {BANKS.map((name, index) => (
            <button key={name} type="button" className={bank === index ? 'on' : ''} onClick={() => { setBank(index); store.patchKit({ activeBank: index }) }}>{name}</button>
          ))}
          <select aria-label="16 Levels" value={levels} onChange={(event) => setLevels(event.target.value as LevelSpread | '')}>
            <option value="">16 Levels off</option>
            <option value="velocity">Velocity</option>
            <option value="tune">Tune</option>
            <option value="filter">Filter</option>
            <option value="decay">Decay</option>
            <option value="attack">Attack</option>
          </select>
          <label>Swing
            <input aria-label="Swing" type="range" min={50} max={75} value={kit.swing} onChange={(event) => store.patchKit({ swing: Number(event.target.value) })} />
          </label>
          <label>Track
            <input aria-label="Track swing" type="range" min={50} max={75} value={kit.trackSwing} onChange={(event) => store.patchKit({ trackSwing: Number(event.target.value) })} />
          </label>
          <button type="button" className={kit.timing ? 'on' : ''} onClick={() => store.patchKit({ timing: !kit.timing })}>{kit.timing ? 'Timing' : 'TC off'}</button>
          {kit.timing && (
            <label>Strength
              <input aria-label="Timing strength" type="range" min={0} max={100} value={Math.round(kit.timingStrength * 100)} onChange={(event) => store.patchKit({ timingStrength: Number(event.target.value) / 100 })} />
            </label>
          )}
          {RATES.map((rate) => (
            <button key={rate} type="button" className={repeat === rate ? 'on' : ''} onClick={() => setRepeat((value) => (value === rate ? null : rate))}>{rate}</button>
          ))}
          <button type="button" className={triplet ? 'on' : ''} onClick={() => setTriplet((value) => !value)}>Triplet</button>
          <button type="button" className={latch ? 'on' : ''} onClick={() => setLatch((value) => !value)}>Latch</button>
          <button type="button" className={fullLevel ? 'on' : ''} onClick={() => setFullLevel((value) => !value)}>Full</button>
          <button type="button" className={accent ? 'on' : ''} onClick={() => setAccent((value) => !value)}>Accent</button>
          <button type="button" className={erase ? 'on' : ''} onClick={() => setErase((value) => !value)}>Erase</button>
          <button type="button" className={recordMode === 'replace' ? 'on' : ''} onClick={() => setRecordMode((value) => (value === 'overdub' ? 'replace' : 'overdub'))}>{recordMode === 'replace' ? 'Replace' : 'Overdub'}</button>
          <button type="button" onClick={() => clip && store.doubleClip(clip.trackId, clip.clipId)}>Double</button>
          <button type="button" onClick={() => store.undoTake()}>Undo take</button>
          <select aria-label="Fixed length" value={fixed} onChange={(event) => setFixed(Number(event.target.value))}>
            <option value={0}>Free</option>
            <option value={4}>1 bar</option>
            <option value={8}>2 bars</option>
            <option value={16}>4 bars</option>
          </select>
          <button type="button" onClick={() => clip && store.addMidiClip(clip.trackId, clipEnd(store, clip.trackId))}>New clip</button>
          <button type="button" onClick={() => {
            const notes = performer.current?.capture() ?? []
            if (!clip || !notes.length) return
            store.addMidiClip(clip.trackId, clipEnd(store, clip.trackId))
            const id = store.selectedMidiClipId
            if (id) store.addPerformedNotes(clip.trackId, id, notes)
          }}>Capture</button>
          <button type="button" className={kit.fill ? 'on' : ''} onClick={() => store.patchKit({ fill: !kit.fill })}>Fill</button>
        </div>
      )}
      <div className={`perform-body${showEdit ? ' show-edit' : ''}`}>
        <div className="perform-play" ref={board}>
          {drums && deck === 'session' ? (
            <SessionPads store={store} mutes={padMutes} solo={soloPads} />
          ) : drums && deck === 'keys' ? (
            <KeyGrid root={scale.root} scaleId={scale.scale} layout={layout} inKey={inKey} />
          ) : drums ? (
            <>
              {browser && (
                <div className="sample-row">
                  <button type="button" onClick={() => store.applyKit('room')}>Room kit</button>
                  <button type="button" onClick={() => store.applyKit('tight')}>Tight kit</button>
                  {DRUM_PADS.map((pad) => (
                    <button key={pad.pitch} type="button" data-sample={pad.pitch}>{pad.name}</button>
                  ))}
                </div>
              )}
              <div className="drum-pads">
                {pads.map((pad, index) => (
                  <button
                    key={`${bank}-${index}`}
                    type="button"
                    data-pitch={levels && source ? source.pitch : pad.pitch}
                    data-index={index}
                    data-level={levels ? index : undefined}
                  >{levels ? levelLabel(index, levels) : pad.name}</button>
                ))}
              </div>
              <KeyGrid root={scale.root} scaleId={scale.scale} layout={layout} inKey={inKey} land />
            </>
          ) : (
            <div className="play-keys">
              {WHITE.map((pc) => {
                const pitch = base + pc
                return <button key={pitch} type="button" className="white" data-pitch={pitch}>{NOTE_NAMES[pc]}</button>
              })}
              <div className="blacks">
                {BLACK.map((pc) => (
                  <button key={pc} type="button" className="black" data-pitch={base + pc} style={{ left: `${((WHITE.indexOf(pc - 1) + 1) / WHITE.length) * 100}%` }} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="perform-edit">
          {drums && deck === 'mix' && source ? (
            <MixPad
              pad={source}
              samples={source.layers[0]?.bufferId ? store.buffers.get(source.layers[0].bufferId)?.channels[0] : undefined}
              onChange={(patch) => store.updatePad(bank, selectedPad, patch)}
              onBus={() => store.routePad(bank, selectedPad)}
              onFlatten={() => store.flattenPad(bank, selectedPad)}
            />
          ) : drums && (deck === 'steps' || deck === 'pads') && clip ? (
            <>
              {deck === 'pads' && (
                <PadTools
                  store={store}
                  engine={engine}
                  bank={bank}
                  padIndex={selectedPad}
                  browser={browser}
                  onBrowser={() => setBrowser((value) => !value)}
                  onSong={() => {
                    store.rememberSequence(clip.trackId, clip.clipId)
                    store.addSongSlot(clip.clipId, 1)
                  }}
                  onPlaySong={() => store.commitSong(clip.trackId)}
                />
              )}
              <StepEditor
                pads={pads}
                notes={clip.notes}
                page={page}
                lengthSteps={lengthSteps}
                heldStep={heldStep}
                ratchet={ratchet}
                lockParam={lockParam}
                onPage={setPage}
                onLength={(steps) => store.setClipLength(clip.trackId, clip.clipId, steps / 4)}
                onRatchet={setRatchet}
                onHold={setHeldStep}
                onLockParam={setLockParam}
                onToggle={(pitch, step) => store.toggleDrumStep(clip.trackId, clip.clipId, pitch, step, ratchet)}
                onEdit={(pitch, step, patch) => store.setStep(clip.trackId, clip.clipId, pitch, step, patch)}
              />
            </>
          ) : drums && deck === 'keys' ? (
            <div className="scale-row">
              <select aria-label="Key" value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
                {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
              <ScaleSelect value={scale.scale} onChange={(id) => store.setScale({ scale: id })} />
              <button type="button" className={layout === 'fourths' ? 'on' : ''} onClick={() => setLayout((value) => (value === 'fourths' ? 'sequential' : 'fourths'))}>{layout === 'fourths' ? 'Fourths' : 'Sequential'}</button>
              <button type="button" className={inKey ? 'on' : ''} onClick={() => setInKey((value) => !value)}>{inKey ? 'In key' : 'Chromatic'}</button>
            </div>
          ) : drums && deck === 'session' ? (
            <div className="tool-row">
              <button type="button" className={padMutes ? 'on' : ''} onClick={() => setPadMutes((value) => !value)}>Mutes</button>
              <button type="button" className={soloPads ? 'on' : ''} onClick={() => setSoloPads((value) => !value)}>Solo</button>
            </div>
          ) : clip ? (
            <div className="roll-grid" aria-label="Piano roll">
              {clip.notes.map((note) => (
                <i key={note.id} style={{ left: `${note.startBeat * 48}px`, width: `${Math.max(8, note.durationBeats * 48)}px`, top: `${(84 - note.pitch) * 8}px` }} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function levelLabel(index: number, spread: LevelSpread) {
  const params = sixteenLevels(index, spread)
  if (spread === 'velocity') return String(Math.round(params.velocity * 127))
  if (spread === 'tune') return `${params.tune > 0 ? '+' : ''}${params.tune.toFixed(0)}`
  return String(Math.round((spread === 'filter' ? params.filter : spread === 'decay' ? params.decay : params.attack) * 100))
}

function KeyGrid({ root, scaleId, layout, inKey, land = false }: { root: number; scaleId: ScaleId; layout: GridLayout; inKey: boolean; land?: boolean }) {
  const cells = []
  for (let row = 7; row >= 0; row--) {
    for (let column = 0; column < 8; column++) cells.push({ ...gridPitch(row, column, root, scaleId, layout, inKey), row, column })
  }
  return (
    <div className={land ? 'grid8 land-grid' : 'grid8'} aria-label={land ? 'Landscape grid' : 'Key grid'}>
      {cells.map((cell) => (
        <button key={`${cell.row}-${cell.column}`} type="button" data-pitch={cell.pitch} className={cell.isRoot ? 'root' : ''}>{NOTE_NAMES[cell.pitch % 12]}</button>
      ))}
    </div>
  )
}

function SessionPads({ store, mutes, solo }: { store: ProjectStore; mutes: boolean; solo: boolean }) {
  const cells: { key: string; trackId: string; clipId: string | null; name: string; on: boolean }[] = []
  for (const track of store.project.tracks) {
    if (track.type === 'bus' || track.type === 'group') continue
    const clips = [
      ...track.midiClips.map((clip) => ({ id: clip.id, name: clip.name })),
      ...track.clips.map((clip) => ({ id: clip.id, name: clip.name })),
    ]
    if (mutes || !clips.length) {
      cells.push({ key: track.id, trackId: track.id, clipId: null, name: track.name, on: mutes ? (solo ? track.solo : track.mute) : false })
    } else {
      for (const clip of clips.slice(0, 4)) {
        cells.push({ key: clip.id, trackId: track.id, clipId: clip.id, name: clip.name, on: store.launched[track.id] === clip.id })
      }
    }
    if (cells.length >= 16) break
  }
  return (
    <div className="session-pads" aria-label="Session grid">
      {cells.slice(0, 16).map((cell) => (
        <button key={cell.key} type="button" className={cell.on ? 'on' : ''} onClick={() => {
          if (mutes) store.toggleTrack(cell.trackId, solo ? 'solo' : 'mute')
          else store.launch(cell.trackId, cell.clipId)
        }}>{cell.name}</button>
      ))}
    </div>
  )
}

function PadTools({
  store, engine, bank, padIndex, browser, onBrowser, onSong, onPlaySong,
}: {
  store: ProjectStore
  engine: AudioEngine
  bank: number
  padIndex: number
  browser: boolean
  onBrowser: () => void
  onSong: () => void
  onPlaySong: () => void
}) {
  const [chop, setChop] = useState<'transient' | 'regions' | 'bpm'>('transient')
  return (
    <div className="tool-row">
      <button type="button" className={browser ? 'on' : ''} onClick={onBrowser}>Browser</button>
      <button type="button" onClick={() => void sampleMic().then((buffer) => buffer && store.assignPadSample(bank, padIndex, buffer, 48000, 'Mic'))}>Mic</button>
      <button type="button" onClick={() => {
        const track = store.project.tracks.find((item) => item.clips.length)
        const clip = track?.clips[0]
        const asset = clip ? store.buffers.get(clip.bufferId) : undefined
        if (track && asset) store.assignPadSample(bank, padIndex, asset.channels[0], asset.sampleRate, track.name)
      }}>Track</button>
      <button type="button" onClick={() => void engine.exportMix(store.project, store.buffers).then((wav) => {
        const decoded = decodeWavPCM(wav)
        const channels = decoded.channels
        const length = channels[0]?.length || 0
        const mono = new Float32Array(length)
        for (let i = 0; i < length; i++) {
          let sum = 0
          for (const channel of channels) sum += channel[i] || 0
          mono[i] = sum / Math.max(1, channels.length)
        }
        store.assignPadSample(bank, padIndex, mono, decoded.sampleRate, 'Master')
      })}>Master</button>
      <select aria-label="Chop" value={chop} onChange={(event) => setChop(event.target.value as 'transient' | 'regions' | 'bpm')}>
        <option value="transient">Transient</option>
        <option value="regions">Regions</option>
        <option value="bpm">BPM</option>
      </select>
      <button type="button" onClick={() => store.chopPad(bank, padIndex, chop, false, { regions: 8, bpm: store.project.tempo })}>Chop</button>
      <button type="button" onClick={() => store.chopPad(bank, padIndex, chop, true, { regions: 8, bpm: store.project.tempo })}>New program</button>
      <button type="button" onClick={onSong}>Add song</button>
      <button type="button" onClick={onPlaySong}>Play song</button>
    </div>
  )
}

function MixPad({
  pad, samples, onChange, onBus, onFlatten,
}: {
  pad: PadVoice
  samples?: Float32Array
  onChange: (patch: Partial<PadVoice>) => void
  onBus: () => void
  onFlatten: () => void
}) {
  return (
    <div>
      <PadWave pad={pad} samples={samples} />
      <div className="knob-row">
        {PAD_MACROS.map((macro) => {
          const [min, max] = MACRO_RANGE[macro]
          const value = pad[macro]
          return (
            <label key={macro}>{macro}
              <input aria-label={macro} type="range" min={min} max={max} step={(max - min) / 100} value={value} onChange={(event) => onChange({ [macro]: Number(event.target.value) } as Partial<PadVoice>)} />
            </label>
          )
        })}
      </div>
      <div className="tool-row">
        <label>Choke
          <input aria-label="Choke group" type="number" min={0} max={8} value={pad.choke} onChange={(event) => onChange({ choke: Number(event.target.value) })} />
        </label>
        <select aria-label="Polyphony" value={pad.poly} onChange={(event) => onChange({ poly: event.target.value === 'mono' ? 'mono' : 'poly' })}>
          <option value="poly">Poly</option>
          <option value="mono">Mono</option>
        </select>
        <select aria-label="Layers" value={pad.layerMode} onChange={(event) => onChange({ layerMode: event.target.value as PadVoice['layerMode'] })}>
          <option value="velocity">Velocity layers</option>
          <option value="robin">Round robin</option>
          <option value="random">Random</option>
        </select>
        <button type="button" onClick={() => {
          if (pad.layers.length >= 4) return
          onChange({ layers: [...pad.layers, { velocityLo: 0.5, velocityHi: 1, tune: 0 }] })
        }}>Add layer</button>
        <button type="button" onClick={onBus}>To bus</button>
        <button type="button" onClick={onFlatten}>Flatten</button>
      </div>
    </div>
  )
}

function PadWave({ pad, samples }: { pad: PadVoice; samples?: Float32Array }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const kind = DRUM_PADS.find((item) => item.pitch === pad.pitch)?.kind ?? 'perc'
    const data = samples ?? renderDrum(kind, 8000, pad.pitch)
    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)
    ctx.beginPath()
    const step = Math.max(1, Math.floor(data.length / width))
    for (let x = 0; x < width; x++) {
      const sample = data[Math.min(data.length - 1, x * step)] || 0
      const y = (0.5 - sample * 0.45) * height
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = '#73c48f'
    ctx.stroke()
    ctx.beginPath()
    const attack = pad.attack * width
    ctx.moveTo(0, height)
    ctx.lineTo(attack, height * (1 - pad.level))
    ctx.lineTo(attack + pad.decay * width * 0.35, height * (1 - pad.sustain * pad.level))
    ctx.lineTo(width, height)
    ctx.strokeStyle = '#e0b15a'
    ctx.stroke()
  }, [pad, samples])
  return <canvas ref={ref} className="pad-wave" width={480} height={96} aria-label="Pad waveform" />
}

function StepEditor({
  pads, notes, page, lengthSteps, heldStep, ratchet, lockParam, onPage, onLength, onRatchet, onHold, onLockParam, onToggle, onEdit,
}: {
  pads: PadVoice[]
  notes: { id: string; pitch: number; startBeat: number; durationBeats: number; velocity: number; probability?: number; condition?: StepCondition; nudge?: number; locks?: Record<string, number>; velocityLo?: number; velocityHi?: number }[]
  page: number
  lengthSteps: number
  heldStep: { pitch: number; column: number } | null
  ratchet: number
  lockParam: string
  onPage: (page: number) => void
  onLength: (steps: number) => void
  onRatchet: (count: number) => void
  onHold: (step: { pitch: number; column: number }) => void
  onLockParam: (param: string) => void
  onToggle: (pitch: number, step: number) => void
  onEdit: (pitch: number, step: number, patch: { velocity?: number; durationBeats?: number; nudge?: number; probability?: number; condition?: StepCondition; velocityLo?: number; velocityHi?: number; lock?: { param: string; value: number } }) => void
}) {
  const absolute = heldStep == null ? null : page * 16 + heldStep.column
  const heldNote = absolute == null || !heldStep ? undefined : notes.find((note) => note.pitch === heldStep.pitch && Math.abs(note.startBeat - (note.nudge || 0) - absolute / 4) < 0.02)
  return (
    <div>
      <div className="step-page">
        {[0, 1, 2, 3].map((item) => (
          <button key={item} type="button" className={page === item ? 'on' : ''} onClick={() => onPage(item)}>{item + 1}</button>
        ))}
        <select aria-label="Loop length" value={Math.min(64, lengthSteps)} onChange={(event) => onLength(Number(event.target.value))}>
          {[16, 32, 48, 64].map((steps) => <option key={steps} value={steps}>{steps}</option>)}
        </select>
        <button type="button" className={ratchet === 2 ? 'on' : ''} onClick={() => onRatchet(ratchet === 2 ? 1 : 2)}>×2</button>
        <button type="button" className={ratchet === 4 ? 'on' : ''} onClick={() => onRatchet(ratchet === 4 ? 1 : 4)}>×4</button>
      </div>
      <div className="step-grid" role="grid" aria-label="Step grid">
        {pads.map((row) => (
          <div className="step-row" key={`${row.pitch}-${row.name}`}>
            <span>{row.name}</span>
            {Array.from({ length: 16 }, (_, column) => {
              const step = page * 16 + column
              const beat = step / 4
              const on = notes.some((note) => note.pitch === row.pitch && note.startBeat >= beat - 0.02 && note.startBeat < beat + 0.23)
              return (
                <button
                  key={step}
                  type="button"
                  className={on ? 'on' : ''}
                  disabled={step >= lengthSteps}
                  aria-label={`${row.name} step ${step + 1}`}
                  onPointerDown={() => onHold({ pitch: row.pitch, column })}
                  onClick={() => onToggle(row.pitch, step)}
                />
              )
            })}
          </div>
        ))}
      </div>
      {heldNote && absolute != null && (
        <div className="knob-row">
          <label>Velocity
            <input aria-label="Step velocity" type="range" min={0.05} max={1} step={0.01} value={heldNote.velocity} onChange={(event) => onEdit(heldNote.pitch, absolute, { velocity: Number(event.target.value) })} />
          </label>
          <label>Length
            <input aria-label="Step length" type="range" min={0.05} max={1} step={0.01} value={heldNote.durationBeats} onChange={(event) => onEdit(heldNote.pitch, absolute, { durationBeats: Number(event.target.value) })} />
          </label>
          <label>Nudge
            <input aria-label="Step nudge" type="range" min={-0.12} max={0.12} step={0.01} value={heldNote.nudge || 0} onChange={(event) => onEdit(heldNote.pitch, absolute, { nudge: Number(event.target.value) })} />
          </label>
          <label>Chance
            <input aria-label="Step probability" type="range" min={0} max={1} step={0.01} value={heldNote.probability ?? 1} onChange={(event) => onEdit(heldNote.pitch, absolute, { probability: Number(event.target.value) })} />
          </label>
          <select aria-label="Condition" value={heldNote.condition || 'always'} onChange={(event) => onEdit(heldNote.pitch, absolute, { condition: event.target.value as StepCondition })}>
            <option value="always">Always</option>
            <option value="1:2">1:2</option>
            <option value="1:4">1:4</option>
            <option value="fill">Fill</option>
          </select>
          <label>Low
            <input aria-label="Velocity low" type="range" min={0} max={1} step={0.01} value={heldNote.velocityLo ?? 0.4} onChange={(event) => onEdit(heldNote.pitch, absolute, { velocityLo: Number(event.target.value) })} />
          </label>
          <label>High
            <input aria-label="Velocity high" type="range" min={0} max={1} step={0.01} value={heldNote.velocityHi ?? 1} onChange={(event) => onEdit(heldNote.pitch, absolute, { velocityHi: Number(event.target.value) })} />
          </label>
          <select aria-label="Lock" value={lockParam} onChange={(event) => onLockParam(event.target.value)}>
            {PAD_MACROS.map((macro) => <option key={macro} value={macro}>{macro}</option>)}
          </select>
          <label>Lock
            <input aria-label="Lock amount" type="range" min={0} max={1} step={0.01} value={heldNote.locks?.[lockParam] ?? 0} onChange={(event) => onEdit(heldNote.pitch, absolute, { lock: { param: lockParam, value: Number(event.target.value) } })} />
          </label>
        </div>
      )}
    </div>
  )
}

function light(outputs: MIDIOutput[], pitch: number, velocity: number) {
  const status = velocity > 0 ? 0x90 : 0x80
  for (const output of outputs) {
    try { output.send([status, pitch & 127, velocity]) } catch { /* port closed */ }
  }
}

async function sampleMic(): Promise<Float32Array | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(2048, 1, 1)
    const silent = ctx.createGain()
    silent.gain.value = 0
    const chunks: Float32Array[] = []
    processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    source.connect(processor)
    processor.connect(silent)
    silent.connect(ctx.destination)
    await new Promise((resolve) => window.setTimeout(resolve, 1200))
    processor.disconnect()
    source.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await ctx.close()
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const mixed = new Float32Array(length)
    let offset = 0
    for (const chunk of chunks) {
      mixed.set(chunk, offset)
      offset += chunk.length
    }
    return mixed.length ? mixed : null
  } catch {
    return null
  }
}

function currentClip(store: ProjectStore) {
  for (const track of store.project.tracks) {
    const clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId) || (track.type === 'midi' ? track.midiClips[0] : undefined)
    if (clip && (store.selectedMidiClipId === clip.id || track.id === store.selectedTrackId)) {
      return { trackId: track.id, clipId: clip.id, notes: clip.notes, durationBeats: clip.durationBeats }
    }
  }
  const track = store.project.tracks.find((item) => item.type === 'midi')
  const clip = track?.midiClips[0]
  return clip && track ? { trackId: track.id, clipId: clip.id, notes: clip.notes, durationBeats: clip.durationBeats } : null
}

function clipEnd(store: ProjectStore, trackId: string) {
  const track = store.project.tracks.find((item) => item.id === trackId)
  return track?.midiClips.reduce((max, item) => Math.max(max, item.startBeat + item.durationBeats), 0) ?? 0
}

function ensureTarget(store: ProjectStore, drums: boolean): PerformTarget | null {
  let track = store.project.tracks.find((item) => item.type === 'midi' && (item.id === store.selectedTrackId || item.midiClips.some((clip) => clip.id === store.selectedMidiClipId)))
  if (!track) track = store.project.tracks.find((item) => item.type === 'midi')
  if (!track) {
    store.addTrack('midi')
    track = store.project.tracks.find((item) => item.type === 'midi')
  }
  if (!track) return null
  let clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId) || track.midiClips[0]
  if (!clip) {
    store.addMidiClip(track.id, 0)
    clip = track.midiClips[track.midiClips.length - 1]
    if (clip && drums) clip.name = 'Drums'
  }
  if (!clip) return null
  return { trackId: track.id, clipId: clip.id, drums }
}
