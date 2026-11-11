import { useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { countInBarsOf, countInCaption } from '../model/time'
import { SNAP_DIVISIONS, normalizeSnapDivision } from '../model/snapGrid'
import type { ProjectStore } from '../state/store'
import { PHONE_TOOL_ROW, TOOL_INFO, activeTool, subscribeTools, type ArrangeTool } from '../state/tools'
import { currentArrangeSheet, subscribeArrangeSheet, toggleArrangeSheet } from './arrangePanel'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import type { BrowserTab } from './PlaylistBrowser'
import { SnapChoices, ToolChoices } from './UtilitySheets'
import { useScreenOverlay } from './screenOverlay'
import {
  BROWSER_TAB_EVENT,
  phoneContextKind,
  type PhonePlace,
} from './phoneContext'
import { phoneFocus, subscribePhoneFocus } from './phoneFocus'
import './phoneDock.css'

const BROWSER_TABS: { id: BrowserTab; label: string }[] = [
  { id: 'sounds', label: 'Sounds' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'loops', label: 'Loops' },
  { id: 'patterns', label: 'Patterns' },
]

function MetronomeIcon() {
  return (
    <svg className="metro-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 14.2h7.6L8.4 2.4 4.2 14.2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 12.6V6.2L11.2 8.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
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
  onMenuAction,
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
  const tool = useSyncExternalStore(subscribeTools, activeTool, activeTool)
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

  function pickTool(id: ArrangeTool) {
    store.setTool(id)
  }

  function splitClip() {
    if (!clip || clip.kind === 'pattern') return
    store.splitAt(clip.trackId, clip.clipId, playheadSample())
  }

  const sheet = offstage === 'tools'
    ? <ToolChoices store={store} onClose={() => setOffstage(null)} omit={PHONE_TOOL_ROW} />
    : offstage === 'snap'
      ? <SnapChoices store={store} onClose={() => setOffstage(null)} />
      : transportMore && place === 'mix'
        ? <TransportMoreSheet store={store} onClose={() => setTransportMore(false)} />
        : null

  return (
    <>
      {host && sheet ? createPortal(sheet, host) : null}
      {kind !== 'arrange' ? <div id="transport-extras" className="transport-extras-slot parked" /> : null}
      <div className="phone-context" role="toolbar" aria-label="Actions" data-phone-context={kind}>
        {kind === 'menu' && (
          <>
            <Hit action="new" label="New" title="Start a fresh session." onClick={() => onMenuAction('new')} />
            <Hit action="open" label="Open" title="Open a project saved in this browser." onClick={() => onMenuAction('open')} />
            <Hit action="save" label="Save" title="Keep this project in the browser." onClick={() => onMenuAction('save')} />
            <Hit action="export" label="Export" title="Bounce or download the mix." onClick={() => onMenuAction('export')} />
          </>
        )}
        {kind === 'browse' && BROWSER_TABS.map((item) => (
          <Hit
            key={item.id}
            action={item.id}
            label={item.label}
            title={`Show ${item.label.toLowerCase()} in the browser.`}
            onClick={() => document.dispatchEvent(new CustomEvent(BROWSER_TAB_EVENT, { detail: item.id }))}
          />
        ))}
        {kind === 'tools' && (
          <>
            {PHONE_TOOL_ROW.map((id) => (
              <Hit
                key={id}
                action={id}
                label={`${TOOL_INFO[id].label}. ${TOOL_INFO[id].hint}`}
                title={TOOL_INFO[id].hint}
                pressed={tool === id}
                onClick={() => pickTool(id)}
              >
                {TOOL_INFO[id].label}
              </Hit>
            ))}
            <Hit action="snap" className="snap-inline" label={snapLabel} title="Snap grid." pressed={snapOn} onClick={openSnap}>
              {snapLabel}
            </Hit>
          </>
        )}
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
          <Hit
            action="more"
            label="More"
            title="Loop, metronome, and count."
            pressed={transportMore}
            onClick={() => setTransportMore((open) => !open)}
          />
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
            <Hit action="setup" label="Setup" title="Automation and markers." pressed={utility === 'setup'} onClick={() => toggleArrangeSheet('setup')} />
            <Hit action="snap" className="snap-inline" label={snapLabel} title="Snap grid." pressed={snapOn} onClick={openSnap}>{snapLabel}</Hit>
            <Hit action="metronome" label="Metronome" title="Metronome while you play and record." pressed={store.project.metronomeEnabled} onClick={() => store.toggle('metronomeEnabled')}>
              <MetronomeIcon />
            </Hit>
            <Hit action="undo" label="Undo" history="undo" disabled={!canUndo} onClick={onUndo}><span className="history-word">Undo</span></Hit>
            <Hit action="redo" label="Redo" history="redo" disabled={!canRedo} onClick={onRedo}><span className="history-word">Redo</span></Hit>
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
          title="Sounds and loops. Open sounds, instruments, and loops."
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
