import { SheetGrab } from './bottomSheet'
import { SheetClose } from './SheetClose'
import type { NameMode, PracticeRate } from '../playalong/types'
import './playAlong.css'

const WHITE = new Set([0, 2, 4, 5, 7, 9, 11])

export interface AlongLaneNote {
  id: string
  pitch: number
  startBeat: number
  label: string
  chord?: boolean
}

export interface AlongPad {
  pitch: number
  name: string
}

export function keySpan(pitches: number[]) {
  if (!pitches.length) return { low: 60, high: 84 }
  const min = Math.min(...pitches)
  const max = Math.max(...pitches)
  let low = Math.floor(min / 12) * 12
  let high = Math.ceil((max + 1) / 12) * 12
  if (high - low < 24) {
    const mid = Math.round(((low + high) / 2) / 12) * 12
    low = mid - 12
    high = mid + 12
  }
  return { low: Math.max(24, low), high: Math.min(108, Math.max(low + 24, high)) }
}

export function PlayAlongFace({
  title,
  subtitle,
  chord,
  bass,
  confidence,
  approximate,
  beat,
  lane,
  drums,
  pads,
  low,
  high,
  lit,
  speed,
  names,
  followKey,
  countLabel,
  countOn,
  loopOn,
  markA,
  markB,
  canConvert,
  playing,
  status,
  onClose,
  onSpeed,
  onNames,
  onFollow,
  onCount,
  onLoop,
  onA,
  onB,
  onStep,
  onPlay,
  onConvert,
  onKey,
}: {
  title: string
  subtitle: string
  chord: string
  bass: string
  confidence: string
  approximate: boolean
  beat: number
  lane: AlongLaneNote[]
  drums: boolean
  pads: AlongPad[]
  low: number
  high: number
  lit: number[]
  speed: PracticeRate
  names: NameMode
  followKey: boolean
  countLabel: string
  countOn: boolean
  loopOn: boolean
  markA: boolean
  markB: boolean
  canConvert: boolean
  playing: boolean
  status: string
  onClose: () => void
  onSpeed: (rate: PracticeRate) => void
  onNames: () => void
  onFollow: () => void
  onCount: () => void
  onLoop: () => void
  onA: () => void
  onB: () => void
  onStep: (direction: -1 | 1) => void
  onPlay: () => void
  onConvert: () => void
  onKey: (pitch: number) => void
}) {
  const litSet = new Set(lit)
  const span = Math.max(1, high - low)
  const whites: number[] = []
  const blacks: number[] = []
  for (let pitch = low; pitch < high; pitch++) {
    if (WHITE.has(((pitch % 12) + 12) % 12)) whites.push(pitch)
    else blacks.push(pitch)
  }
  const whiteIndex = new Map(whites.map((pitch, index) => [pitch, index]))
  return (
    <section
      className="play-along-sheet bottom-sheet"
      data-play-along="sheet"
      data-kind={drums ? 'drums' : 'keys'}
      role="dialog"
      aria-label="Play along"
      style={{ ['--beat' as string]: String(beat) }}
    >
      <SheetGrab label="Resize play along. Drag up or down." />
      <header className="along-head">
        <div className="along-title">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="along-chord" data-chord={chord} data-approximate={approximate ? 'true' : 'false'} data-confidence={confidence}>
          <b>{chord || '—'}</b>
          <small data-bass="">{bass}</small>
          <small>{confidence}</small>
        </div>
        <SheetClose onClick={onClose} />
      </header>
      <div className="along-tools" role="group" aria-label="Practice">
        {([0.5, 0.75, 1] as PracticeRate[]).map((rate) => (
          <button key={rate} type="button" aria-pressed={speed === rate} data-play-speed={rate} title={rate === 1 ? 'Full speed.' : `Practice at ${Math.round(rate * 100)}% speed without changing pitch.`} onClick={() => onSpeed(rate)}>
            {Math.round(rate * 100)}%
          </button>
        ))}
        <button type="button" aria-pressed={markA} data-play-mark="a" title="Set A at the playhead." onClick={onA}>A</button>
        <button type="button" aria-pressed={markB} data-play-mark="b" title="Set B at the playhead." onClick={onB}>B</button>
        <button type="button" aria-pressed={loopOn} data-play-loop="" title="Loop the section between A and B." onClick={onLoop}>Loop</button>
        <button type="button" data-play-step="-1" title="Step back one note." onClick={() => onStep(-1)}>Back</button>
        <button type="button" data-play-step="1" title="Step forward one note." onClick={() => onStep(1)}>Next</button>
        <button type="button" aria-pressed={countOn} data-play-count="" title="Count in before the clip." onClick={onCount}>{countLabel}</button>
        <button type="button" aria-pressed={names === 'solfege'} data-play-names={names} title="Switch note names between letters and solfège." onClick={onNames}>
          {names === 'solfege' ? 'Do Re Mi' : 'Letters'}
        </button>
        <button type="button" aria-pressed={followKey} data-play-key="" title="Spell notes in the song key." onClick={onFollow}>Key</button>
        <button type="button" aria-pressed={playing} data-play-along-play="" title={playing ? 'Stop.' : 'Play this clip from the start.'} onClick={onPlay}>
          {playing ? 'Stop' : 'Play'}
        </button>
      </div>
      <div className="along-body">
        {status ? <p className="along-status" data-play-status="">{status}</p> : null}
        <div className="along-lane" data-play-lane="">
          <div className="along-scroll">
            {lane.map((note) => (
              <div
                key={note.id}
                className={note.chord ? 'along-note chord-pill' : 'along-note'}
                data-note={note.pitch}
                style={{
                  ['--start' as string]: String(note.startBeat),
                  left: note.chord ? 8 : `${((note.pitch - low) / span) * 100}%`,
                }}
              >
                {note.label}
              </div>
            ))}
          </div>
          <div className="along-line" />
        </div>
        {drums ? (
          <div className="along-pads" role="group" aria-label="Drums">
            {pads.map((pad) => (
              <button key={pad.pitch} type="button" data-key={pad.pitch} className={litSet.has(pad.pitch) ? 'lit' : ''} aria-pressed={litSet.has(pad.pitch)} title={`Play ${pad.name}.`} onClick={() => onKey(pad.pitch)}>
                {pad.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="along-keys" role="group" aria-label="Piano">
            <div className="along-keybed" style={{ width: whites.length * 26 }}>
              {whites.map((pitch, index) => (
                <button key={pitch} type="button" data-key={pitch} className={litSet.has(pitch) ? 'lit' : ''} style={{ left: index * 26 }} title={`Play ${pitch}.`} onClick={() => onKey(pitch)}>
                  <span className="key-name">{litSet.has(pitch) ? laneName(lane, pitch) : ''}</span>
                </button>
              ))}
              {blacks.map((pitch) => {
                let below = pitch - 1
                while (!WHITE.has(((below % 12) + 12) % 12)) below -= 1
                const index = whiteIndex.get(below) ?? 0
                return (
                  <button key={pitch} type="button" data-key={pitch} className={litSet.has(pitch) ? 'black lit' : 'black'} style={{ left: index * 26 + 18 }} title={`Play ${pitch}.`} onClick={() => onKey(pitch)}>
                    <span className="key-name">{litSet.has(pitch) ? laneName(lane, pitch) : ''}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {canConvert ? (
          <button type="button" className="along-convert" data-play-convert="" title="Make an editable MIDI clip from this transcription. One undo puts it back." onClick={onConvert}>
            Convert to MIDI
          </button>
        ) : null}
      </div>
    </section>
  )
}

function laneName(lane: AlongLaneNote[], pitch: number) {
  return lane.find((note) => note.pitch === pitch && !note.chord)?.label ?? ''
}
