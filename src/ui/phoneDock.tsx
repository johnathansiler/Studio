import { useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { countInBarsOf, countInCaption } from '../model/time'
import { SNAP_DIVISIONS, normalizeSnapDivision } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { TOOL_INFO, activeTool, subscribeTools, type ArrangeTool } from '../state/tools'
import { currentArrangeSheet, subscribeArrangeSheet, toggleArrangeSheet } from './arrangePanel'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import { SnapChoices } from './UtilitySheets'
import { eqCols } from './equalGrid'
import { useScreenOverlay } from './screenOverlay'
import {
  phoneContextKind,
  type PhonePlace,
} from './phoneContext'
import { phoneFocus, subscribePhoneFocus } from './phoneFocus'
import './phoneDock.css'

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
    <ArrangeBottomSheet id="phone-transport-more" label="More" title="More" detail="Loop, metronome, and count." onClose={onClose}>
      <div className="phone-more-rows" role="group" aria-label="Loop, metronome, and count">
        <button type="button" aria-pressed={project.loopEnabled} onClick={() => store.toggle('loopEnabled')}>
          <strong>Loop</strong>
          <span>{project.loopEnabled ? 'On' : 'Off'}</span>
        </button>
        <button type="button" aria-pressed={project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
          <strong>Metronome</strong>
          <span>{project.metronomeEnabled ? 'On' : 'Off'}</span>
        </button>
        <button type="button" aria-pressed={project.countIn} onClick={() => store.cycleCountIn()}>
          <strong>Count</strong>
          <span>{count}</span>
        </button>
      </div>
    </ArrangeBottomSheet>
  )
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
  menuRef,
  onMenu,
  onBrowse,
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
  menuRef: RefObject<HTMLButtonElement | null>
  onMenu: () => void
  onBrowse: () => void
  onMenuAction: (action: string) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  playheadSample: () => number
}) {
  const utility = useSyncExternalStore(subscribeArrangeSheet, currentArrangeSheet, () => null)
  const focus = useSyncExternalStore(subscribePhoneFocus, phoneFocus, () => 'none' as const)
  const [offstage, setOffstage] = useState<'tools' | 'snap' | null>(null)
  const [transportMore, setTransportMore] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const arrangeLive = place === 'arrange'
  const toolsOpen = (arrangeLive && utility === 'tools') || offstage === 'tools'
  const snapOn = store.project.snap !== false
  const division = normalizeSnapDivision(store.project.snapDivision)
  const gridLabel = SNAP_DIVISIONS.find((item) => item.id === division)?.label ?? division
  const snapLabel = `Snap ${snapOn ? gridLabel : 'Off'}`
  const clip = selectedClip(store)
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
  useScreenOverlay(() => setTransportMore(false), transportMore && place === 'mix')

  function openTools() {
    if (menuOpen) onMenu()
    if (browseOpen) onBrowse()
    if (arrangeLive) {
      toggleArrangeSheet('tools')
      return
    }
    setOffstage((value) => (value === 'tools' ? null : 'tools'))
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
      {kind !== 'arrange' && kind !== 'mix' ? <div id="transport-extras" className="transport-extras-slot parked" /> : null}
      {toolsOpen ? <PhoneToolRow store={store} onClose={closeTools} /> : null}
      <div className={`phone-context${kind === 'arrange' ? ' btn-tray' : ''}${kind === 'mix' ? ' eq-grid phone-mix-row' : ''}`} style={kind === 'mix' ? eqCols(4) : undefined} role="toolbar" aria-label="Actions" data-phone-context={kind}>
        {kind === 'clip' && clip && (
          <>
            {clip.kind !== 'pattern' && (
              <Hit action="split" label="Split" title="Split the clip at the playhead." onClick={splitClip} />
            )}
            <Hit action="duplicate" label="Duplicate" title="Copy the selection and place it just after." onClick={() => store.duplicateSelection()} />
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
          </>
        )}
        {kind === 'notes' && (
          <>
            <Hit action="duplicate" label="Duplicate" title="Copy the selected notes and place them just after." onClick={() => store.duplicateSelection()} />
            <Hit action="delete" label="Delete" title="Remove the selected notes." onClick={() => store.deleteSelectedClip()} />
          </>
        )}
        {kind === 'mix' && (
          <>
            <div id="transport-extras" className="transport-extras-slot" />
            <Hit
              action="more"
              label="More"
              title="Loop, metronome, and count."
              pressed={transportMore}
              onClick={() => setTransportMore((open) => !open)}
            />
          </>
        )}
        {kind === 'collab' && (
          <>
            <Hit action="undo" label="Undo" history="undo" disabled={!canUndo} onClick={onUndo}><span className="history-word">Undo</span></Hit>
            <Hit action="redo" label="Redo" history="redo" disabled={!canRedo} onClick={onRedo}><span className="history-word">Redo</span></Hit>
          </>
        )}
        {kind === 'plugin' && (
          <>
            <Hit action="undo" label="Undo" history="undo" disabled={!canUndo} onClick={onUndo}><span className="history-word">Undo</span></Hit>
            <Hit action="redo" label="Redo" history="redo" disabled={!canRedo} onClick={onRedo}><span className="history-word">Redo</span></Hit>
            <Hit action="metronome" label="Metronome" title="Metronome while you play and record." pressed={store.project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
              <MetronomeIcon />
            </Hit>
          </>
        )}
        {kind === 'arrange' && (
          <>
            <Hit action="undo" label="Undo" history="undo" disabled={!canUndo} onClick={onUndo}><span className="history-word">Undo</span></Hit>
            <Hit action="redo" label="Redo" history="redo" disabled={!canRedo} onClick={onRedo}><span className="history-word">Redo</span></Hit>
            <Hit action="snap" className="snap-inline" label={snapLabel} title="Snap grid." pressed={snapOn} onClick={openSnap}>Snap</Hit>
            <Hit action="setup" label="Setup" title="Automation and markers." pressed={utility === 'setup'} onClick={() => toggleArrangeSheet('setup')}>
              <GearIcon />
            </Hit>
            <Hit action="metronome" label="Metronome" title="Metronome while you play and record." pressed={store.project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
              <MetronomeIcon />
            </Hit>
            <div id="transport-extras" className="transport-extras-slot" />
          </>
        )}
      </div>
      <div className="phone-tabs" aria-label="Phone">
        <button
          ref={menuRef}
          type="button"
          className={`phone-tab menu-btn${menuOpen ? ' active on' : ''}`}
          data-phone-tab="menu"
          aria-pressed={menuOpen}
          aria-label="Menu. Project, edit, view, and settings."
          title="Project, edit, view, and settings."
          aria-expanded={menuOpen}
          aria-controls="shell-menu"
          onClick={onMenu}
        >
          <span className="menu-word">Menu</span>
        </button>
        <button
          type="button"
          className={`phone-tab${browseOpen ? ' active on' : ''}`}
          data-phone-tab="browse"
          aria-pressed={browseOpen}
          aria-label="Browse"
          title="My Library, patterns, and clips."
          onClick={onBrowse}
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
      </div>
    </>
  )
}
