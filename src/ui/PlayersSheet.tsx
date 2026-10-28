import { useSyncExternalStore } from 'react'
import type { AnalysisChord, AnalysisSection } from '../analysis/types'
import { cachedAnalyses, subscribeAnalysis } from '../analysis/cache'
import type { AnalysisResult } from '../analysis/types'
import type { AudioEngine } from '../audio/engine'
import { STYLES } from '../generators/styles'
import { buildSession } from '../players'
import { selectPlayers } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'
import './players.css'

const STYLE = 'The drummer, bass, and keys all play in this style.'
const PAD = 'Drag right for a busier part. Drag up for louder. The middle follows each section.'
const FILL = 'How big a drum fill to play at the end of each section.'
const FOLLOW = 'Use the intro, verse, and chorus from Analyze. The middle of the pad is that arrangement.'
const REGION = 'Bars the drummer and the players write. Bar 1 is the start of the song.'
const DRUMS = 'Write a drum part on the Drums track. It plays the built-in kit, and you can edit every hit.'
const BASS = 'Write a bass line that follows the chords.'
const KEYS = 'Write a keys part that follows the chords.'
const HEAR = 'Listen to the drummer before writing.'
const WRITE = 'Put the parts on the tracks as MIDI you can edit.'
const ANOTHER = 'Write a different take in the same style.'
const CLOSE = 'Close the players. The song stays as it is.'

export function PlayersSheet({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const { settings, follow } = selectPlayers(store)
  const analyses = useSyncExternalStore(subscribeAnalysis, cachedAnalyses, cachedAnalyses)
  const detected = detection(analyses)
  const sections = detected.sections.length
    ? detected.sections.map((section) => section.label).join(' · ')
    : 'No sections yet. Analyze a track and the drummer will follow them.'
  const preview = () => {
    const built = buildSession(store.project, settings, detected)
    const drums = built.parts.find((part) => part.role === 'drums')
    const part = drums ?? built.parts[0]
    if (!part?.notes.length) return
    engine.unlock()
    const beat = 60 / Math.max(40, store.project.tempo)
    engine.previewSequence(part.notes.slice(0, 480).map((note) => ({
      pitch: note.pitch,
      at: note.startBeat * beat,
      dur: Math.max(0.05, note.durationBeats * beat),
      velocity: note.velocity,
      drum: part.role === 'drums',
      cents: note.fine ?? 0,
    })))
  }
  const setPad = (complexity: number, loudness: number) => store.setPlayers({ complexity, loudness }, true)
  const followLine = follow.source === 'track'
    ? 'Following the chord track.'
    : follow.source === 'idea'
      ? 'Following the chord idea.'
      : follow.source === 'memory'
        ? 'Following the last progression.'
        : 'No chord track yet. The players write a progression, unless Analyze found chords.'

  return (
    <aside className="players-dock" aria-label="Players">
      <header>
        <strong>Players</strong>
        <TipButton label="Close" hint={CLOSE} onClick={onClose} />
      </header>
      <p className="players-readout">{settings.followSections ? sections : 'One region, with a fill at the end.'}</p>
      <p className="players-readout">{followLine}</p>
      <label className="players-style">
        Style
        <select
          aria-label={`Style. ${STYLE}`}
          title={STYLE}
          value={settings.style}
          onChange={(event) => store.setPlayers({ style: event.target.value })}
        >
          {STYLES.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
        </select>
      </label>
      <div
        className="players-pad"
        role="group"
        aria-label={PAD}
        title={PAD}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          movePad(event, setPad)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) movePad(event, setPad)
        }}
        onPointerUp={() => store.endDraft()}
      >
        <i style={{ left: `${settings.complexity * 100}%`, top: `${(1 - settings.loudness) * 100}%` }} />
        <small className="axis-x">Busier</small>
        <small className="axis-y">Louder</small>
      </div>
      <p className="hint">{PAD}</p>
      <label className="players-fill">
        Fills {Math.round(settings.fills * 100)}
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.fills * 100)}
          aria-label={`Fills. ${FILL}`}
          title={FILL}
          onChange={(event) => store.setPlayers({ fills: Number(event.target.value) / 100 }, true)}
          onPointerUp={() => store.endDraft()}
        />
      </label>
      <label className="players-region">
        <input
          type="checkbox"
          checked={settings.followSections}
          aria-label={`Follow sections. ${FOLLOW}`}
          title={FOLLOW}
          onChange={(event) => store.setPlayers({ followSections: event.target.checked })}
        />
        Follow sections
      </label>
      <div className="players-region">
        <label>
          From
          <input
            type="number"
            min={1}
            max={257}
            value={settings.startBar + 1}
            aria-label={`From bar. ${REGION}`}
            title={REGION}
            onChange={(event) => store.setPlayers({ startBar: Math.max(0, Number(event.target.value) - 1) })}
          />
        </label>
        <label>
          To
          <input
            type="number"
            min={settings.startBar + 2}
            max={settings.startBar + 65}
            value={settings.endBar}
            aria-label={`To bar. ${REGION}`}
            title={REGION}
            onChange={(event) => store.setPlayers({ endBar: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="players-parts">
        <TipButton label="Drums" hint={DRUMS} className={settings.drummer ? 'on' : ''} pressed={settings.drummer} onClick={() => store.setPlayers({ drummer: !settings.drummer })} />
        <TipButton label="Bass" hint={BASS} className={settings.bass ? 'on' : ''} pressed={settings.bass} onClick={() => store.setPlayers({ bass: !settings.bass })} />
        <TipButton label="Keys" hint={KEYS} className={settings.keys ? 'on' : ''} pressed={settings.keys} onClick={() => store.setPlayers({ keys: !settings.keys })} />
      </div>
      <div className="players-actions">
        <TipButton label="Hear" hint={HEAR} onClick={preview} />
        <TipButton label="Write" hint={WRITE} className="primary" disabled={store.remoteFollow || (!settings.drummer && !settings.bass && !settings.keys)} onClick={() => store.writeSession(detected)} />
        <TipButton label="Another" hint={ANOTHER} disabled={store.remoteFollow} onClick={() => store.writeSession(detected, (settings.seed + 1) >>> 0)} />
      </div>
    </aside>
  )
}

function movePad(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }, setPad: (complexity: number, loudness: number) => void) {
  const box = event.currentTarget.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return
  const complexity = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
  const loudness = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height))
  setPad(complexity, loudness)
}

function detection(results: readonly AnalysisResult[]): { sections: AnalysisSection[]; detected: AnalysisChord[] } {
  let sections: AnalysisSection[] = []
  let detected: AnalysisChord[] = []
  for (const found of results) {
    if (found.sections.length > sections.length) sections = found.sections
    if (found.chordsByBar.length > detected.length) detected = found.chordsByBar
  }
  return { sections, detected }
}
