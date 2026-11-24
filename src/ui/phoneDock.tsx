import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { VariationBar } from './VariationBar'
import { createPortal } from 'react-dom'
import { countInBarsOf, countInCaption } from '../model/time'
import { SNAP_DIVISIONS, normalizeSnapDivision } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { TOOL_INFO, activeTool, subscribeTools, type ArrangeTool } from '../state/tools'
import { currentArrangeSheet, subscribeArrangeSheet, toggleArrangeSheet } from './arrangePanel'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import { SnapChoices } from './UtilitySheets'
import { DeleteTrackConfirm, applyTrackDelete } from './equalGrid'
import { useScreenOverlay } from './screenOverlay'
import { ClipTempoControl } from './ClipTempoControl'
import { keyShiftReadout } from '../model/keyFit'
import {
  phoneContextKind,
  type PhonePlace,
} from './phoneContext'
import { phoneFocus, subscribePhoneFocus } from './phoneFocus'
import { playAlongOpen, setPlayAlongOpen, subscribePlayAlong, togglePlayAlong } from './playAlongBus'
import './phoneDock.css'
import './clipTempo.css'

const HarmonizeSheet = lazy(() => import('./HarmonizeSheet').then((mod) => ({ default: mod.HarmonizeSheet })))

function GearIcon() {
  return (
    <svg className="dock-icon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="2.15" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 1.7v1.7M9 14.6v1.7M1.7 9h1.7M14.6 9h1.7M3.7 3.7l1.2 1.2M13.1 13.1l1.2 1.2M14.3 3.7l-1.2 1.2M4.9 13.1l-1.2 1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function MetronomeIcon() {
  return (
    <svg className="metro-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 14.2h7.6L8.4 2.4 4.2 14.2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 12.6V6.2L11.2 8.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function LoopIcon() {
  return (
    <svg className="loop-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 6.1a4.4 4.4 0 0 1 7.7-1.5M12.6 9.9a4.4 4.4 0 0 1-7.7 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.2 2.8 12.2 4.6 10.1 6.4M5.8 13.2 3.8 11.4 5.9 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg className="t-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 4.2h9.6M6.2 4.1V3h3.6v1.1M4.4 4.2l.6 8.2h5.9l.6-8.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const PHONE_TOOLS: ArrangeTool[] = ['select', 'pencil', 'split', 'trim', 'zoom', 'box', 'erase', 'pan']

function toolFace(id: ArrangeTool) {
  if (id === 'pan') return { label: 'Scroll', hint: 'Scroll the timeline or the piano roll. This is not the mixer pan.' }
  const info = TOOL_INFO[id]
  return { label: info.label, hint: info.hint }
}

/** Eight tools in the same tray metrics as the edit row, so each one sits on a dock button. */
function PhoneToolRow({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const value = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  return (
    <div id="tool-choices" className="phone-tool-row btn-tray" role="toolbar" aria-label="Tools" data-tool-row="open">
      {PHONE_TOOLS.map((id) => {
        const face = toolFace(id)
        return (
          <Hit
            key={id}
            action={id}
            label={`${face.label}. ${face.hint}`}
            title={face.hint}
            pressed={value === id}
            onClick={() => { store.setTool(id); onClose() }}
          >
            {face.label}
          </Hit>
        )
      })}
    </div>
  )
}

function rollView(): { start: number; end: number } | null {
  if (typeof document === 'undefined') return null
  const roll = document.querySelector<HTMLElement>('.roll')
  if (!roll) return null
  const px = Number(roll.dataset.pxBeat)
  if (!(px > 0)) return null
  const start = roll.scrollLeft / px
  return { start, end: start + Math.max(1, roll.clientWidth) / px }
}

function EditActions({
  store,
  mode,
  playheadSample,
  includeDuplicate = true,
}: {
  store: ProjectStore
  mode: 'clips' | 'notes' | 'steps'
  playheadSample: () => number
  includeDuplicate?: boolean
}) {
  const offer = mode === 'notes' ? store.notePasteState() : mode === 'steps' ? store.stepPasteState() : store.clipPasteState()
  const noun = mode === 'notes' ? 'notes' : mode === 'steps' ? 'steps' : 'clips'
  function run(command: 'copy' | 'cut' | 'paste' | 'duplicate') {
    if (command === 'paste' && !offer.ready) {
      store.toast(offer.reason || `Copy ${noun} first.`, 'warn')
      return
    }
    const seen = rollView()
    store.editCommand(command, mode, playheadSample(), seen?.start ?? null, seen?.end ?? null)
  }
  return (
    <>
      <Hit action="copy" label="Copy" title={`Copy the selected ${noun}.`} onClick={() => run('copy')} />
      <Hit action="cut" label="Cut" title={`Cut the selected ${noun}.`} onClick={() => run('cut')} />
      {offer.visible && (
        <Hit
          action="paste"
          className={offer.ready ? '' : 'is-muted'}
          label="Paste"
          title={offer.ready ? `Paste ${noun} at the playhead.` : offer.reason}
          onClick={() => run('paste')}
        />
      )}
      {includeDuplicate && (
        <Hit action="duplicate" label="Duplicate" title={`Copy the selected ${noun} and place them just after.`} onClick={() => run('duplicate')} />
      )}
    </>
  )
}

/** Paste stays available after Cut clears the selection. Copy does not. */
function ClipboardPaste({
  store,
  mode,
  playheadSample,
}: {
  store: ProjectStore
  mode: 'clips' | 'notes' | 'steps'
  playheadSample: () => number
}) {
  const offer = mode === 'notes' ? store.notePasteState() : mode === 'steps' ? store.stepPasteState() : store.clipPasteState()
  if (!offer.visible) return null
  const noun = mode === 'notes' ? 'notes' : mode === 'steps' ? 'steps' : 'clips'
  return (
    <Hit
      action="paste"
      className={offer.ready ? '' : 'is-muted'}
      label="Paste"
      title={offer.ready ? `Paste ${noun} at the playhead.` : offer.reason}
      onClick={() => {
        if (!offer.ready) {
          store.toast(offer.reason || `Copy ${noun} first.`, 'warn')
          return
        }
        const seen = rollView()
        store.editCommand('paste', mode, playheadSample(), seen?.start ?? null, seen?.end ?? null)
      }}
    />
  )
}

function noteEditorOpen() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
  return Boolean(document.querySelector('.roll, .drum-roll'))
}

function Hit({
  action,
  label,
  title,
  pressed = false,
  disabled = false,
  className = '',
  history,
  onClick,
  children,
}: {
  action: string
  label: string
  title?: string
  pressed?: boolean
  disabled?: boolean
  className?: string
  history?: 'undo' | 'redo'
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      className={`phone-hit${pressed ? ' on' : ''} ${className}`.trim()}
      data-phone-action={action}
      data-history={history}
      aria-pressed={pressed}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="phone-face">{children ?? label}</span>
    </button>
  )
}

function TransportMoreSheet({ store, onClose }: { store: ProjectStore; onClose: () => void }) {
  const project = store.project
  const count = countInCaption(countInBarsOf(project))
  return (
    <ArrangeBottomSheet id="phone-transport-more" label="More" title="More" detail="Loop, metronome, and count-in." onClose={onClose}>
      <div className="phone-more-rows" role="group" aria-label="Loop, metronome, and count-in">
        <button type="button" aria-pressed={project.loopEnabled} onClick={() => store.toggle('loopEnabled')}>
          <strong>Loop</strong>
          <span>{project.loopEnabled ? 'On' : 'Off'}</span>
        </button>
        <button type="button" aria-pressed={project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
          <strong>Metronome</strong>
          <span>{project.metronomeEnabled ? 'On' : 'Off'}</span>
        </button>
        <button type="button" aria-pressed={project.countIn} onClick={() => store.cycleCountIn()}>
          <strong>Count-in</strong>
          <span>{count}</span>
        </button>
      </div>
    </ArrangeBottomSheet>
  )
}

function midiKeyShift(store: ProjectStore) {
  if (!store.selectedMidiClipId) return null
  for (const track of store.project.tracks) {
    const clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId)
    if (!clip?.keyShift?.semitones) continue
    const line = keyShiftReadout({ stretch: { semitones: clip.keyShift.semitones }, keyShift: clip.keyShift })
    if (!line) continue
    return (
      <div className="clip-hearing" data-key-shift-dock="" role="region" aria-label="Shifted key">
        <p data-key-shift-readout="">{line}</p>
        <button type="button" data-key-revert="" title="Put this clip back on its original pitch." onClick={() => store.revertKeyShift(track.id, clip.id)}>
          Revert to original
        </button>
      </div>
    )
  }
  return null
}

function selectedClip(store: ProjectStore) {
  if (store.selectedClipId) {
    for (const track of store.project.tracks) {
      const clip = track.clips.find((item) => item.id === store.selectedClipId)
      if (clip) return { trackId: track.id, clipId: clip.id, loop: clip.loop === true, kind: 'audio' as const }
    }
  }
  if (store.selectedMidiClipId) {
    for (const track of store.project.tracks) {
      const clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId)
      if (clip) return { trackId: track.id, clipId: clip.id, loop: clip.loop === true, kind: 'midi' as const }
    }
  }
  if (store.selectedPatternClipId) {
    const clip = store.project.patternClips?.find((item) => item.id === store.selectedPatternClipId)
    if (clip) return { trackId: clip.trackId || store.selectedTrackId || '', clipId: clip.id, loop: false, kind: 'pattern' as const }
  }
  return null
}

export function PhoneDock({
  store,
  place,
  menuOpen,
  browseOpen,
  ideasOpen,
  onMenu,
  onBrowse,
  onIdeas,
  onWarmBrowse,
  onMenuAction: _onMenuAction,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  playheadSample,
}: {
  store: ProjectStore
  place: PhonePlace
  menuOpen: boolean
  browseOpen: boolean
  ideasOpen: boolean
  onMenu: () => void
  onBrowse: () => void
  onIdeas: () => void
  onWarmBrowse?: () => void
  onMenuAction: (action: string) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  playheadSample: () => number
}) {
  const along = useSyncExternalStore(subscribePlayAlong, playAlongOpen, () => false)
  const utility = useSyncExternalStore(subscribeArrangeSheet, currentArrangeSheet, () => null)
  const focus = useSyncExternalStore(subscribePhoneFocus, phoneFocus, () => 'none' as const)
  const [offstage, setOffstage] = useState<'tools' | 'snap' | null>(null)
  const [transportMore, setTransportMore] = useState(false)
  const [trackDelete, setTrackDelete] = useState<{ id: string; name: string } | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const arrangeLive = place === 'arrange'
  const toolsOpen = (arrangeLive && utility === 'tools') || offstage === 'tools'
  const harmonizeOpen = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.harmonizeOpen,
    () => false,
  )
  const snapOn = store.project.snap !== false
  const division = normalizeSnapDivision(store.project.snapDivision)
  const gridLabel = SNAP_DIVISIONS.find((item) => item.id === division)?.label ?? division
  const snapLabel = `Snap ${snapOn ? gridLabel : 'Off'}`
  const clip = selectedClip(store)
  const audioTempo = clip?.kind === 'audio' ? clip : null
  const notes = store.selectedNoteIds.length > 0 && Boolean(store.selectedMidiClipId)
  const kind = phoneContextKind({
    sheet: menuOpen ? 'menu' : browseOpen ? 'browse' : toolsOpen ? 'tools' : null,
    place,
    notes,
    clip: Boolean(clip),
    track: focus === 'track' && Boolean(store.selectedTrackId),
  })
  const trackId = clip?.trackId || store.selectedTrackId
  const track = trackId ? store.track(trackId) : null
  void _onMenuAction

  useEffect(() => {
    const node = document.getElementById('phone-sheet-host')
    setHost(node)
  }, [])

  useEffect(() => {
    if (!arrangeLive || !offstage) return
    const id = offstage
    setOffstage(null)
    toggleArrangeSheet(id)
  }, [arrangeLive, offstage])

  useEffect(() => {
    if (place !== 'mix' || menuOpen || browseOpen) setTransportMore(false)
  }, [place, menuOpen, browseOpen])
  useEffect(() => {
    if (menuOpen || browseOpen || ideasOpen) setPlayAlongOpen(false)
  }, [menuOpen, browseOpen, ideasOpen])
  useScreenOverlay(() => setTransportMore(false), transportMore && place === 'mix')

  function closeIdeas() {
    if (ideasOpen) onIdeas()
  }

  function openTools() {
    if (menuOpen) onMenu()
    if (browseOpen) onBrowse()
    closeIdeas()
    if (arrangeLive) {
      toggleArrangeSheet('tools')
      return
    }
    setOffstage((value) => (value === 'tools' ? null : 'tools'))
  }

  function openIdeas() {
    if (menuOpen) onMenu()
    if (browseOpen) onBrowse()
    closeTools()
    onIdeas()
  }

  function openSnap() {
    if (arrangeLive) {
      toggleArrangeSheet('snap')
      return
    }
    setOffstage((value) => (value === 'snap' ? null : 'snap'))
  }

  function splitClip() {
    if (!clip || clip.kind === 'pattern') return
    store.splitAt(clip.trackId, clip.clipId, playheadSample())
  }

  const countBars = countInBarsOf(store.project)
  const countCaption = countInCaption(countBars)
  const trackArmed = focus === 'track' && Boolean(track)
  const showArrangeDelete = Boolean(clip || notes || trackArmed)
  function deleteArrangeSelection() {
    if (clip || notes) {
      store.deleteSelectedClip()
      return
    }
    if (trackArmed && track) setTrackDelete({ id: track.id, name: track.name })
  }

  function closeTools() {
    if (arrangeLive) {
      if (utility === 'tools') toggleArrangeSheet('tools')
    } else setOffstage(null)
  }

  useEffect(() => {
    if (!toolsOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTools()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toolsOpen, arrangeLive, utility])

  const sheet = offstage === 'snap'
    ? <SnapChoices store={store} onClose={() => setOffstage(null)} />
    : transportMore && place === 'mix'
      ? <TransportMoreSheet store={store} onClose={() => setTransportMore(false)} />
      : null

  return (
    <>
      {host && sheet ? createPortal(sheet, host) : null}
      {trackDelete ? createPortal(
        <DeleteTrackConfirm
          name={trackDelete.name}
          onChoose={(choice) => {
            applyTrackDelete(store, trackDelete.id, choice)
            setTrackDelete(null)
          }}
        />,
        document.body,
      ) : null}
      {kind !== 'arrange' && kind !== 'mix' ? <div id="transport-extras" className="transport-extras-slot parked" /> : null}
      {toolsOpen ? (
        <>
          <button
            type="button"
            className="harmonize-launch"
            data-harmonize-song=""
            title="Shift every harmonic clip into one key. Drums, percussion, and effects stay put."
            onClick={() => { closeTools(); store.requestHarmonize() }}
          >
            Harmonize song
          </button>
          <PhoneToolRow store={store} onClose={closeTools} />
        </>
      ) : null}
      {harmonizeOpen ? (
        <Suspense fallback={null}>
          <HarmonizeSheet store={store} />
        </Suspense>
      ) : null}
      {audioTempo ? <ClipTempoControl store={store} trackId={audioTempo.trackId} clipId={audioTempo.clipId} /> : null}
      {midiKeyShift(store)}
      {clip && place === 'arrange' ? <VariationBar store={store} /> : null}
      <div className="phone-context btn-tray phone-context-tray" role="toolbar" aria-label="Actions" data-phone-context={kind} data-edit-row={kind === 'arrange' && clip ? 'clips' : kind === 'notes' ? 'notes' : undefined}>
        {kind === 'clip' && clip && (
          <>
            <EditActions store={store} mode="clips" playheadSample={playheadSample} />
            {clip.kind !== 'pattern' && (
              <Hit action="split" label="Split" title="Split the clip at the playhead." onClick={splitClip} />
            )}
            <Hit action="play-along" label="Play along" title="See each note as it plays, and play it back." pressed={along} onClick={() => togglePlayAlong()}>
              Play along
            </Hit>
            <Hit action="delete" label="Delete" title="Remove the selection." onClick={() => store.deleteSelectedClip()} />
            {track && (
              <>
                <Hit action="mute" label="Mute" title="Silence this track." pressed={track.mute} onClick={() => store.toggleTrack(track.id, 'mute')} />
                <Hit action="solo" label="Solo" title="Hear only this track." pressed={track.solo} onClick={() => store.toggleTrack(track.id, 'solo')} />
              </>
            )}
            {clip.kind !== 'pattern' && (
              <Hit
                action="loop"
                label="Loop"
                title="Loop this clip."
                pressed={clip.loop}
                onClick={() => store.setClipLaunch(clip.trackId, clip.clipId, { loop: !clip.loop })}
              />
            )}
          </>
        )}
        {kind === 'track' && track && (
          <>
            <Hit action="mute" label="Mute" title="Silence this track." pressed={track.mute} onClick={() => store.toggleTrack(track.id, 'mute')} />
            <Hit action="solo" label="Solo" title="Hear only this track." pressed={track.solo} onClick={() => store.toggleTrack(track.id, 'solo')} />
            <Hit action="delete" label="Delete" title={`Delete track ${track.name}.`} onClick={() => setTrackDelete({ id: track.id, name: track.name })}>
              <DeleteIcon />
            </Hit>
          </>
        )}
        {kind === 'notes' && (
          <>
            <EditActions store={store} mode="notes" playheadSample={playheadSample} />
            <Hit action="delete" label="Delete" title="Remove the selected notes." onClick={() => store.deleteSelectedClip()} />
          </>
        )}
        {kind === 'mix' && (
          <>
            <div id="transport-extras" className="transport-extras-slot" />
            <Hit
              action="more"
              label="More"
              title="Loop, metronome, and count-in."
              pressed={transportMore}
              onClick={() => setTransportMore((open) => !open)}
            />
          </>
        )}
        {kind === 'plugin' && store.stepTrackId && store.selectedRackSteps.length > 0 && (
          <EditActions store={store} mode="steps" playheadSample={playheadSample} />
        )}
        {kind === 'plugin' && !(store.stepTrackId && store.selectedRackSteps.length > 0) && (
          <>
            {store.stepTrackId ? (
              <ClipboardPaste store={store} mode="steps" playheadSample={playheadSample} />
            ) : noteEditorOpen() ? (
              <ClipboardPaste store={store} mode="notes" playheadSample={playheadSample} />
            ) : null}
            <Hit action="undo" label="Undo" history="undo" disabled={!canUndo} onClick={onUndo}><span className="history-word">Undo</span></Hit>
            <Hit action="redo" label="Redo" history="redo" disabled={!canRedo} onClick={onRedo}><span className="history-word">Redo</span></Hit>
            <Hit action="metronome" label="Metronome" title="Metronome while you play and record." pressed={store.project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
              <MetronomeIcon />
            </Hit>
          </>
        )}
        {kind === 'arrange' && clip && (
          <>
            <EditActions store={store} mode="clips" playheadSample={playheadSample} />
            <div id="transport-extras" className="transport-extras-slot" />
            <Hit action="play-along" label="Play along" title="See each note as it plays, and play it back." pressed={along} onClick={() => togglePlayAlong()}>
              Play along
            </Hit>
            <Hit action="delete" label="Delete" title="Remove the selection." onClick={() => store.deleteSelectedClip()}>
              <DeleteIcon />
            </Hit>
          </>
        )}
        {kind === 'arrange' && !clip && (
          <>
            <ClipboardPaste store={store} mode="clips" playheadSample={playheadSample} />
            <Hit action="undo" label="Undo" history="undo" disabled={!canUndo} onClick={onUndo}><span className="history-word">Undo</span></Hit>
            <Hit action="redo" label="Redo" history="redo" disabled={!canRedo} onClick={onRedo}><span className="history-word">Redo</span></Hit>
            <Hit action="snap" className="snap-inline" label={snapLabel} title="Snap grid." pressed={snapOn} onClick={openSnap}>Snap</Hit>
            <Hit action="setup" label="Setup" title="Automation and markers." pressed={utility === 'setup'} onClick={() => toggleArrangeSheet('setup')}>
              <GearIcon />
            </Hit>
            <Hit action="metronome" label="Metronome" title="Metronome while you play and record." pressed={store.project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
              <MetronomeIcon />
            </Hit>
            <Hit
              action="loop"
              label={`Loop. ${store.project.loopEnabled ? 'On' : 'Off'}`}
              title="Repeat the highlighted region. Drag its edges to change the length."
              pressed={store.project.loopEnabled}
              onClick={() => store.toggle('loopEnabled')}
            >
              <LoopIcon />
            </Hit>
            <Hit
              action="count-in"
              label={`Count-in. ${countCaption}`}
              title={`Count-in is ${countCaption}. Tap for off, one bar, or two bars.`}
              pressed={countBars > 0}
              onClick={() => store.cycleCountIn()}
            >
              <span className="count-state" data-count-state={countCaption}>{countCaption}</span>
            </Hit>
            <div id="transport-extras" className="transport-extras-slot" />
            {showArrangeDelete && (
              <Hit
                action="delete"
                label="Delete"
                title={clip || notes ? 'Remove the selection.' : `Delete track ${track?.name ?? ''}.`}
                onClick={deleteArrangeSelection}
              >
                <DeleteIcon />
              </Hit>
            )}
          </>
        )}
      </div>
      <div className="phone-tabs" aria-label="Browse, Tools, and Ideas">
        <button
          type="button"
          className={`phone-tab${browseOpen ? ' active on' : ''}`}
          data-phone-tab="browse"
          aria-pressed={browseOpen}
          aria-label="Browse"
          title="My Library, patterns, and clips."
          onPointerEnter={onWarmBrowse}
          onTouchStart={onWarmBrowse}
          onClick={() => { closeIdeas(); onBrowse() }}
        >
          Browse
        </button>
        <button
          type="button"
          className={`phone-tab${toolsOpen ? ' active on tool-current' : ''}`}
          data-phone-tab="tools"
          aria-pressed={toolsOpen}
          aria-expanded={toolsOpen}
          aria-controls="tool-choices"
          aria-label="Tools"
          title="Select, draw, split, trim, zoom, box, erase, and snap."
          onClick={openTools}
        >
          Tools
        </button>
        <button
          type="button"
          className={`phone-tab${ideasOpen ? ' active on' : ''}`}
          data-phone-tab="ideas"
          aria-pressed={ideasOpen}
          aria-label="Ideas"
          title="Pick a part, or write a full song. The MIDI stays editable."
          onClick={openIdeas}
        >
          Ideas
        </button>
      </div>
    </>
  )
}
