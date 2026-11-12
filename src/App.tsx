import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FEATURES, preferArrangeTransport, preferArrangeView } from './features'
import { installControlGuards } from './ui/gestures'
import { AudioEngine } from './audio/engine'
import { unpackProject } from './model/archive'
import { renderDemoLoop } from './model/demo'
import { isSessionLink, isUntouchedEmpty, needsNewProjectConfirm, NEW_PROJECT, planLaunch, readTab, roomOwnsOpenProject, shouldKeepProject, TAB_PROJECT } from './model/launchProject'
import { punchWindow, sliceCapture } from './model/comp'
import { watchSpectral } from './audio/spectral/job'
import { inspectClip } from './audio/stretch/engine'
import { createEmptyProject, isLocalInput, uid, type AudioClip, type TakeLane } from './model/types'
import { AwarenessChannel, bindAwareness, currentEditCursor, localAwareness, onPresencePoke } from './remote/presence'
import { SessionClient } from './remote/session'
import { watchLibraryProject } from './library/project'
import { buildRoomCopy, deleteProject, listProjects, listSnapshots, listVersions, loadLastProject, loadProject, loadRoomCopy, loadSnapshot, requestPersistentStorage, saveProject, saveRoomCopy, saveVersion, storageReport, type ProjectListItem, type WorkspaceSnapshot } from './storage/idb'
import { joinAction } from './model/negotiate'
import { locksProject, readInviteToken } from './state/ops'
import { forgetStoredCollab, readIdentity, replaceInviteUrl, writeIdentity } from './storage/identity'
import { selectPiano } from './state/select'
import { ProjectStore, seedDemoProject } from './state/store'
import { digestProject, musicalClone } from './state/ops'
import { shouldSaveVersion, versionTitle, type VersionReason } from './state/versions'
import { linearResample } from './model/wav'
import { isSilentTake } from './model/media'
import { applyTransportLaunch, recordedLength } from './model/launch'
import { shouldCountIn } from './model/sessionInteract'
import { editorForGesture, releaseKeyboardForPiano } from './model/editorOpen'
import { shouldCloseOnscreenPiano } from './model/onscreenPiano'
import { armedRecordPlan, playPress, playStartsCapture, recordPress, startPress, stopPress } from './model/transport'
import { keepLandscapeAfterClose } from './ui/keyboardStage'
import { countInAt, meterAtSample, projectSampleBeat, tempoAtSample } from './model/tempoMap'
import { displayedPlayhead } from './model/transportSync'
import { beatsToSamples, countInBarsOf, samplesToBeats } from './model/time'

const FaceGallery = lazy(() => import('./ui/faces/PluginFace').then((mod) => ({ default: mod.FaceGallery })))
import { guestFollowStart, scheduleLeadMs } from './model/sessionSync'
import { TunerPop } from './ui/AmpPop'
import { ArrangeView } from './ui/ArrangeView'
import { StepSequencerPanel } from './ui/StepSequencerPanel'
import type { TrackChoice } from './model/addTrack'
import { ExportSheet } from './ui/ExportSheet'
import { collectRecordInputs } from './midi/inputs'
import { hidesHardwareMidi } from './model/midiTools'
import { formFactor, type FormFactor } from './ui/form'
import { MidiTools } from './ui/MidiTools'
import { PerformPop } from './ui/PerformPop'
import { MixerView } from './ui/MixerView'
import { PluginSheet } from './ui/PluginSheet'
import { LazySheet } from './ui/sheetFallback'
import { ideasPageFromSearch, ideasSheetRequested, type IdeasPage } from './unstuck/ideasPage'
import './ui/guideSheet.css'
import { panelChoice } from './ui/panelMemory'
import { ShellBrowser } from './ui/PlaylistBrowser'
import { browserWidthFor, usePushPhase } from './ui/dockPush'
import { PadsPanel } from './ui/PadsPanel'
import { ScalerPanel } from './ui/ScalerPanel'
import { clampSoundWidth, readSoundWidth } from './sounds/panel'
import { loadScaleCatalog } from './theory'
import { QuantizeSheet } from './ui/QuantizeSheet'
import { MidiDock } from './ui/MidiDock'
import { ProjectSheet } from './ui/ProjectSheet'
import { PatchSheet } from './ui/PatchSheet'
import { RackView } from './ui/RackView'
import { collabBadgeOn, collabPanelVisible, type StudioTab } from './ui/collabTab'
import './ui/collab.css'
import { AnchoredMenu } from './ui/AnchoredMenu'
import { ButtonTray } from './ui/ButtonTray'
import { IdeasBulbIcon, TransportBar } from './ui/TransportBar'
import { ToolBar } from './ui/ToolBar'
import { SnapControl } from './ui/SnapControl'
import { activeTool } from './state/tools'
import { VideoDock } from './ui/VideoDock'

declare const __CUEHARBOR_SESSION__: boolean

const UnstuckSheet = lazy(() => import('./unstuck/UnstuckSheet').then((mod) => ({ default: mod.UnstuckSheet })))
const AnalysisSheet = lazy(() => import('./ui/AnalysisSheet').then((mod) => ({ default: mod.AnalysisSheet })))
const KnockPop = lazy(() => import('./ui/KnockPop').then((mod) => ({ default: mod.KnockPop })))
const SpectralSheet = lazy(() => import('./ui/SpectralSheet').then((mod) => ({ default: mod.SpectralSheet })))
const SessionPane = __CUEHARBOR_SESSION__
  ? lazy(() => import('./ui/SessionView').then((mod) => ({ default: mod.SessionView })))
  : function HiddenSession(_props: Record<string, unknown>) { return null }
import { visibleMenu } from './ui/chrome'
import { ViewSwitcher } from './ui/ViewSwitcher'
import { PhoneDock } from './ui/phoneDock'
import { CLOSE_ARRANGE_SHEETS, type PhonePlace } from './ui/phoneContext'
import { MainMenu } from './ui/MainMenu'
import { dockVisible, EDITOR_DOCK_DEFAULT, fittedDockWidth, paneAfterRestore, pianoDockWidth, readSessionDock, writeSessionDock } from './ui/sessionDock'
import { deletesSelection } from './ui/clipKeys'
import { historyCommand, typingTarget } from './state/history'
import { claimComputerKey } from './model/keyboardPlay'
import { KeyboardDock } from './ui/KeyboardDock'
import { TransportActionContext } from './ui/pluginTransport'
import { browserLandscapeHost, dismissKeyboard, editorHistoryStep, isHistoryMark, keyboardShellTurn, notifyKeyboard, PADS_HISTORY, PIANO_HISTORY, presentKeyboard, releaseOrientation, setKeyboardPresenter, setPianoHider, STEPS_HISTORY, type EditorHistoryMark, type KeyboardPresentation } from './ui/keyboardStage'
import { sheetHistoryPop } from './ui/arrangePanel'
import { onViewTab, syncPhoneSheetFrame, syncViewTabFrame } from './ui/overlayHost'
import { useScreenOverlay } from './ui/screenOverlay'
import { HintBubble } from './ui/Hint'
import { WaveEditor } from './ui/WaveEditor'
import { Toasts } from './ui/Toasts'
import { HistoryButtons } from './ui/HistoryButtons'
import { formatBytes } from './ui/share'
import { alignPluginClose } from './ui/pluginStage'

interface Bundle {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
}

function opensBlank(): boolean {
  try {
    const reload = sessionStorage.getItem('cueharbor-tab') === '1'
    const current = sessionStorage.getItem(TAB_PROJECT)
    return planLaunch({ reload, search: window.location.search, current }) === 'empty'
  } catch {
    return false
  }
}

function createBundle(): Bundle {
  const engine = new AudioEngine()
  const opened = opensBlank()
    ? { project: createEmptyProject(), buffers: new Map() }
    : seedDemoProject(48000, renderDemoLoop(48000, 4, 120))
  const store = new ProjectStore(opened.project, opened.buffers)
  const session = new SessionClient(engine)
  return { store, engine, session }
}

export function App() {
  const [{ store, engine, session }] = useState(createBundle)

  useEffect(() => watchLibraryProject(store), [store])

  useEffect(() => {
    const hook = window as unknown as {
      __cueharbor?: { engine: AudioEngine; store: ProjectStore }
      __cueharborPlayhead?: number
      __cueharborStatus?: string
      __cueharborRate?: number
    }
    hook.__cueharbor = { engine, store }
    const id = window.setInterval(() => {
      hook.__cueharborPlayhead = engine.currentTimelineSample()
      hook.__cueharborStatus = engine.status
      hook.__cueharborRate = engine.sampleRate
    }, 40)
    return () => window.clearInterval(id)
  }, [engine])
  useEffect(() => watchSpectral(store), [store])
  useEffect(() => installControlGuards(document), [])
  useEffect(() => {
    const warm = () => {
      void import('./ui/IdeasPop')
      void import('./ui/PlayersSheet')
      void import('./unstuck/UnstuckSheet')
      void import('./ui/AnalysisSheet')
      void import('./ui/KnockPop')
      void import('./ui/SpectralSheet')
    }
    const idle = window.requestIdleCallback
    if (typeof idle === 'function') {
      const id = idle(warm, { timeout: 1600 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(warm, 400)
    return () => window.clearTimeout(timer)
  }, [])
  const [version, setVersion] = useState(0)
  const [surface, setSurface] = useState<'studio' | 'artist'>('studio')
  const [dock, setDock] = useState(() => fittedDockWidth(typeof window === 'undefined' ? 1280 : window.innerWidth, EDITOR_DOCK_DEFAULT))
  const [dockEdge, setDockEdge] = useState<'right' | 'bottom'>('right')
  const editorPanel = useRef('room')
  const publishAwareness = useRef<() => void>(() => undefined)
  useEffect(() => {
    const fit = () => setDock((value) => fittedDockWidth(window.innerWidth, value, dockEdge, editorPanel.current === 'piano' ? 0.72 : 0.5))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [dockEdge])
  useEffect(() => {
    const channel = new AwarenessChannel((message) => session.postAware(message))
    bindAwareness(channel)
    session.setAwarenessHandler((msg) => {
      if (msg.t === 'peer-left') channel.forget(String(msg.id || ''))
      else channel.ingest(msg)
    })
    const publish = () => {
      const status = session.state.status
      if (status === 'idle' || status === 'rejected' || status === 'removed' || status === 'error') {
        channel.silence()
        channel.clear()
        return
      }
      const selfId = session.state.selfId
      if (status !== 'live' || !selfId) {
        channel.silence()
        return
      }
      channel.setSelf(selfId)
      const project = store.project
      const cursorSample = Math.max(0, Math.round(engine.positionSamples))
      const piano = selectPiano(store)
      const rollOpen = editorPanel.current === 'piano'
      channel.publish(selfId, localAwareness({
        name: session.state.name,
        cursorSample,
        songBeat: projectSampleBeat(project, displayedPlayhead(cursorSample, project)),
        trackId: store.selectedTrackId,
        clipIds: [...store.selectedClipIds, ...store.selectedMidiClipIds, ...store.selectedPatternClipIds],
        noteIds: store.selectedNoteIds,
        playing: engine.status === 'playing' || engine.status === 'recording',
        recording: session.selfAccess() === 'edit' && engine.status === 'recording',
        rollOpen,
        clip: piano.clip,
        rollTrackId: piano.track?.id ?? null,
        pointer: currentEditCursor(),
      }))
    }
    publishAwareness.current = publish
    const stopStore = store.subscribe(publish)
    const stopEngine = engine.subscribe(publish)
    const stopSession = session.subscribe(publish)
    const stopPoke = onPresencePoke(publish)
    publish()
    return () => {
      publishAwareness.current = () => undefined
      stopStore()
      stopEngine()
      stopSession()
      stopPoke()
      session.setAwarenessHandler(null)
      bindAwareness(null)
      channel.dispose()
    }
  }, [engine, session, store])
  const [joinName, setJoinName] = useState(store.project.name ? localStorage.getItem('cueharbor-name') || 'Artist' : 'Artist')
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [snapshots, setSnapshots] = useState<{ key: string; savedAt: number }[]>([])
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [draftName, setDraftName] = useState(store.project.name)
  const [usage, setUsage] = useState('')
  const [persisted, setPersisted] = useState(true)
  const [help, setHelp] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [latencyHint, setLatencyHint] = useState(() => engine.latencyChoice)
  const [latencyReadout, setLatencyReadout] = useState(() => engine.latencyReadout())
  useEffect(() => {
    if (!menuOpen) return
    const tick = () => setLatencyReadout(engine.latencyReadout())
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [menuOpen, engine])
  const [recordHint, setRecordHint] = useState('')
  const [form, setForm] = useState<FormFactor>(() => formFactor(window.innerWidth, window.innerHeight))
  const [land, setLand] = useState(() => window.innerWidth > window.innerHeight)
  const phone = form === 'phone'
  const editorView = preferArrangeView(store.view)
  const rackRoll = editorView === 'beats' && store.project.tracks.some((track) => track.midiClips.some((clip) => clip.id === store.selectedMidiClipId && clip.channelId))
  useEffect(() => {
    if (!rackRoll || phone) return
    setDock((value) => (value < 640 ? 640 : value))
  }, [rackRoll, phone])
  const [phonePane, setPhonePane] = useState<'edit' | 'room'>('edit')
  const [collabOpen, setCollabOpen] = useState(() => readSessionDock())
  const [pianoOpen, setPianoOpen] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const place = () => {
      syncViewTabFrame(shellRef.current)
      syncPhoneSheetFrame(shellRef.current)
    }
    place()
    const observer = new ResizeObserver(place)
    if (shellRef.current) observer.observe(shellRef.current)
    for (const selector of ['.views', '.transport', '.tool-slot']) {
      const node = shellRef.current?.querySelector(selector)
      if (node) observer.observe(node)
    }
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [form, land, phone, editorView])
  const [keysLandscape, setKeysLandscape] = useState(false)
  const [screenAngle, setScreenAngle] = useState<number | null>(() => {
    if (typeof screen === 'undefined' || !screen.orientation) return null
    return screen.orientation.angle
  })
  const keysMode = useRef<KeyboardPresentation>('dock')
  const keysFromClick = useRef(false)
  const settleGen = useRef(0)
  const ignorePop = useRef(0)
  const editorHistory = useRef<EditorHistoryMark | null>(null)
  const recordReady = useRef(false)
  const recordEpoch = useRef(0)
  const holdLandscape = useRef(false)
  const [tuneOpen, setTuneOpen] = useState(() => new URLSearchParams(window.location.search).get('tune') === '1')
  const [knockOpen, setKnockOpen] = useState(() => new URLSearchParams(window.location.search).get('knock') === '1')
  const [ideasPage, setIdeasPage] = useState<IdeasPage>(() => ideasPageFromSearch(window.location.search))
  const [unstuckOpen, setUnstuckOpen] = useState(() => ideasSheetRequested(window.location.search))
  const [soundsOpen, setSoundsOpen] = useState(() => {
    if (new URLSearchParams(window.location.search).get('sounds') === '1') return true
    return panelChoice('arrangeBrowser') ?? formFactor(window.innerWidth, window.innerHeight) === 'desk'
  })
  const [shellWidth] = useState(() => browserWidthFor(typeof window === 'undefined' ? 1440 : window.innerWidth, typeof window === 'undefined' ? 900 : window.innerHeight))
  const [soundWidth, setSoundWidth] = useState(() => readSoundWidth(undefined, window.innerWidth))
  const soundReserveRef = useRef(0)
  useEffect(() => {
    const open = () => setSoundsOpen(true)
    window.addEventListener('cueharbor-open-sounds', open)
    return () => window.removeEventListener('cueharbor-open-sounds', open)
  }, [])
  useEffect(() => {
    void loadScaleCatalog().then(() => setVersion((value) => value + 1))
  }, [])
  const [analysisTrackId, setAnalysisTrackId] = useState<string | null>(null)
  const [perform, setPerform] = useState<'keys' | 'drums' | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const projectFileRef = useRef<HTMLInputElement>(null)
  const takeRef = useRef<{ id: string; endSample: number } | null>(null)
  const punchTimer = useRef(0)
  const armedPeers = useRef(new Set<string>())
  const launchKey = useRef('')
  const publishTimer = useRef(0)
  const roomTimer = useRef(0)
  const versionSave = useRef<(reason: VersionReason) => void>(() => {})
  const roomSave = useRef<() => void>(() => {})
  const [versionTick, setVersionTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => versionSave.current('timer'), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const pendingFollow = useRef<Record<string, unknown> | null>(null)
  const workletWarned = useRef(false)
  const surfaceRef = useRef(surface)
  const phonePaneRef = useRef(phonePane)
  const flushSave = useRef<() => void>(() => {})
  const launchChoice = useRef<{ plan: 'restore' | 'empty'; reload: boolean } | null>(null)
  if (launchChoice.current === null) {
    let tab = { reload: true, current: null as string | null }
    try { tab = readTab(sessionStorage) } catch { /* no sessionStorage: keep the last project */ }
    launchChoice.current = {
      reload: tab.reload,
      plan: planLaunch({ reload: tab.reload, search: window.location.search, current: tab.current }),
    }
  }
  surfaceRef.current = surface
  phonePaneRef.current = phonePane

  useEffect(() => {
    session.bindArrangement(store)
    session.setRoomPersistence({
      load: (code) => loadRoomCopy(code),
      loadBuffers: async (projectId) => (await loadProject(projectId).catch(() => null))?.buffers ?? new Map(),
      save: async () => {
        roomSave.current()
      },
    })
    session.setTakeHandler((take) => {
      const channels = take.sampleRate === engine.sampleRate
        ? take.channels
        : take.channels.map((channel) => linearResample(channel, take.sampleRate, engine.sampleRate))
      const next = { ...take, channels, sampleRate: engine.sampleRate }
      if (take.upgrade && store.upgradeAlignedTake(next)) return
      store.acceptAlignedTake(next)
    })
    session.setArrangementHandler((project, assets, ready) => {
      if (locksProject(session.state.role, session.selfAccess())) store.remoteFollow = true
      else if (session.state.role === 'guest' && session.selfAccess() === 'edit') store.remoteFollow = false
      if (session.usingOps) {
        for (const [id, asset] of assets) store.buffers.set(id, asset)
        engine.sync(store.project, (id) => assets.get(id) || store.buffers.get(id))
      } else {
        store.loadProject(project, assets)
        engine.sync(project, (id) => assets.get(id) || store.buffers.get(id))
      }
      if (ready && pendingFollow.current && engine.status === 'stopped') void followPlay(pendingFollow.current)
    })
    session.setControlHandler((cmd) => {
      const action = String(cmd.action || '')
      if (action === 'launch' || action === 'scene' || action === 'stop-clips' || action === 'back') {
        if (!FEATURES.session || session.state.role === 'host') return
        const next = applyTransportLaunch(
          { launched: store.launched, at: store.launchAt, gen: store.launchGen, mode: store.transportMode },
          {
            action,
            trackId: cmd.trackId ? String(cmd.trackId) : undefined,
            clipId: cmd.clipId == null || cmd.clipId === '' ? null : String(cmd.clipId),
            timelineSample: Number(cmd.timelineSample),
            slots: Array.isArray(cmd.slots) ? (cmd.slots as { trackId: string; clipId: string | null; timelineSample?: number }[]) : undefined,
            gen: cmd.gen && typeof cmd.gen === 'object' ? (cmd.gen as Record<string, number>) : undefined,
          },
        )
        const stopped = engine.status === 'stopped'
        store.replaceSession(next, engine.currentTimelineSample())
        if (action === 'back' || action === 'stop-clips') return
        if (stopped && next.mode === 'session' && Object.values(next.launched).some(Boolean)) {
          const localPerf = guestFollowStart({
            hostPerfAtSample: Number(cmd.hostPerfAtSample) || performance.now(),
            clockOffsetMs: session.hostOffsetMs(),
            oneWayMs: session.primaryOneWay()?.ms ?? 40,
            nowPerf: performance.now(),
          })
          void engine.playAtPerf(Number(cmd.timelineSample) || 0, localPerf, 'session')
        }
        return
      }
      if (action === 'reset') {
        void applyLocalReset()
        return
      }
      if (session.state.role === 'host') {
        if (action === 'play') void playFrom(engine.currentTimelineSample())
        else if (action === 'stop') void stop()
        else if (action === 'seek') void locate(Number(cmd.timelineSample) || 0)
        return
      }
      if (action === 'play') {
        pendingFollow.current = cmd
        void followPlay(cmd)
      } else if (action === 'stop') {
        pendingFollow.current = null
        engine.stop()
      }
      else if (action === 'seek') {
        engine.seek(Number(cmd.timelineSample) || 0)
      }
    })
    const params = new URLSearchParams(location.search)
    if (params.get('knock') === '1') {
      const track = store.project.tracks.find((item) => item.type === 'midi')
      if (track) {
        if (!track.rack?.devices.some((device) => device.kind === 'knock')) store.addDevice(track.id, 'knock')
        const other = track.rack?.devices.find((device) => device.kind !== 'knock')
        if (other && (track.rack?.devices.length || 0) > 1) store.removeDevice(track.id, other.id)
        if (store.rackTrackId !== track.id) store.openRack(track.id)
        store.setView('arrange')
        setKnockOpen(true)
        setSurface('studio')
        setPhonePane('edit')
      }
    }
    const urlCode = (params.get('session') || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const urlInvite = readInviteToken(location.search)
    forgetStoredCollab()
    const identity = readIdentity()
    if (identity?.transportMode) store.setTransportMode(identity.transportMode)
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const action = joinAction({ urlCode, storedCode: '', hasParticipant: Boolean(identity?.participantId) })
    const joinNameNow = identity?.name || joinName || 'Artist'
    if (action === 'auto-join') {
      if (ios && !navigator.userActivation?.isActive) session.holdMediaForGesture()
      session.connect({ name: joinNameNow, code: urlCode, invite: urlInvite })
      writeSessionDock(true)
      setCollabOpen(true)
    }
    engine.sync(store.project, (id) => store.buffers.get(id))
    engine.followTrack(store.selectedTrackId)
    const unsub = store.subscribe(() => {
      engine.sync(store.project, (id) => store.buffers.get(id))
      engine.followTrack(store.selectedTrackId)
      engine.setLaunches(store.launched)
      engine.setLaunchAt(store.launchAt)
      engine.setLaunchGen(store.launchGen)
      if (session.state.status === 'live') {
        window.clearTimeout(publishTimer.current)
        publishTimer.current = window.setTimeout(() => session.publishEdits(), 40)
        if (session.sharesRoom()) {
          window.clearTimeout(roomTimer.current)
          roomTimer.current = window.setTimeout(() => roomSave.current(), 600)
        }
      }
      const key = `${store.transportMode}:${JSON.stringify(store.launched)}:${JSON.stringify(store.launchAt)}:${JSON.stringify(store.launchGen)}`
      const pending = store.takePendingTransport()
      const playing = engine.status === 'playing' || engine.status === 'recording'
      if (session.state.role !== 'guest' && pending) {
        const sessionLaunch = FEATURES.session && store.transportMode === 'session'
        if (!playing && sessionLaunch && Object.values(store.launched).some(Boolean)) {
          void playFrom(engine.positionSamples, 'session', 'session-launch')
        } else {
          const at = Number(pending.timelineSample)
          const sample = Number.isFinite(at) ? at : Math.round(engine.currentTimelineSample())
          const lead = scheduleLeadMs(session.primaryOneWay()?.ms ?? 40)
          session.broadcastTransport({
            ...pending,
            timelineSample: sample,
            hostPerfAtSample: engine.perfAtTimeline(sample) ?? performance.now() + lead,
            tempo: store.project.tempo,
            timeSignature: store.project.timeSignature,
            mode: preferArrangeTransport(store.transportMode),
          })
          if (playing && sessionLaunch) {
            if (engine.currentMode() !== 'session') engine.adoptSession()
            else engine.kickSession()
          } else if (playing && pending.action === 'back') engine.adoptArrangement()
        }
      }
      if (key !== launchKey.current) {
        launchKey.current = key
        if (FEATURES.session && session.state.role === 'guest') {
          if (store.transportMode === 'arrangement') {
            if (playing && engine.currentMode() === 'session') engine.adoptArrangement()
          } else if (playing && engine.currentMode() !== 'session') engine.adoptSession()
          else if (playing) engine.kickSession()
        }
      }
      setVersion((value) => value + 1)
    })
    const followTimer = window.setInterval(() => {
      if (session.state.role === 'guest') return
      const rolling = FEATURES.session && (engine.status === 'playing' || engine.status === 'recording') && store.transportMode === 'session'
      store.tickSession(engine.currentTimelineSample(), rolling)
    }, 40)
    return () => {
      unsub()
      window.clearInterval(followTimer)
    }
  }, [store, engine, session])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('board') === '1') {
      const track = store.project.tracks.find((item) => item.type === 'audio')
      if (track) {
        let plugin = track.plugins.find((item) => item.pluginId === 'amp')
        if (!plugin) {
          store.addPlugin(track.id, 'amp', 'Glass Room')
          plugin = store.track(track.id)?.plugins.find((item) => item.pluginId === 'amp')
        }
        if (plugin) store.focusPlugin(track.id, plugin.id)
        store.setView('mix')
        setSurface('studio')
        setPhonePane('edit')
      }
    }
    if (params.get('ideas') === '1') {
      const track = store.project.tracks.find((item) => item.type === 'midi')
      if (track && !track.midiClips.length) store.addMidiClip(track.id, 0)
      if (track) store.selectTrack(track.id)
      store.setView('arrange')
      setSurface('studio')
      setPhonePane('edit')
      setIdeasPage('progressions')
      setUnstuckOpen(true)
    }
  }, [store])

  useEffect(() => {
    const saveReady = { current: false }
    let timer = 0
    let lastQuota = 0
    let cancel = false
    const snapshot = (): WorkspaceSnapshot => ({
      view: preferArrangeView(store.view),
      transportMode: preferArrangeTransport(store.transportMode),
      positionSamples: Math.round(engine.positionSamples),
      selectedTrackId: store.selectedTrackId,
      surface: surfaceRef.current,
      phonePane: phonePaneRef.current,
    })
    let lastSnapshot = 0
    const remember = (id: string) => {
      try { sessionStorage.setItem(TAB_PROJECT, id) } catch { /* private mode keeps the in-memory project */ }
    }
    const write = (forceSnapshot = false) => {
      if (!saveReady.current || cancel) return
      if (isUntouchedEmpty(store.project) && store.buffers.size === 0) {
        remember(NEW_PROJECT)
        return
      }
      remember(store.project.id)
      const snap = forceSnapshot || Date.now() - lastSnapshot > 20000
      if (snap) lastSnapshot = Date.now()
      const stamp = store.editStamp()
      void saveProject(store.project, store.buffers, snapshot(), { snapshot: snap }).then((result) => {
        if (result === 'ok') store.markSaved(stamp)
        if (result === 'quota' && Date.now() - lastQuota > 15000) {
          lastQuota = Date.now()
          store.toast('This browser is out of space, so the latest recording could not be kept.', 'warn')
        }
      }).catch(() => undefined)
    }
    const restoreSaved = (saved: NonNullable<Awaited<ReturnType<typeof loadLastProject>>>) => {
      store.loadProject(saved.project, saved.buffers)
      store.setView(preferArrangeView(saved.workspace.view))
      store.setTransportMode(preferArrangeTransport(saved.workspace.transportMode))
      if (saved.workspace.selectedTrackId) store.selectTrack(saved.workspace.selectedTrackId)
      if (saved.workspace.surface === 'artist') {
        setSurface('studio')
        writeSessionDock(true)
        setCollabOpen(true)
      } else setSurface(saved.workspace.surface)
      setPhonePane(paneAfterRestore(saved.workspace.phonePane, false))
      engine.seek(saved.workspace.positionSamples || 0)
      engine.sync(store.project, (id) => store.buffers.get(id))
      remember(saved.project.id)
    }
    const launch = launchChoice.current ?? { plan: 'restore' as const, reload: true }
    void (async () => {
      await requestPersistentStorage()
      const saved = await loadLastProject().catch(() => null)
      if (cancel) return
      if (roomOwnsOpenProject(session.state.status)) {
        /* the room copy already replaced this tab */
      } else if (launch.plan === 'empty') {
        remember(NEW_PROJECT)
        if (!launch.reload && saved && shouldKeepProject(saved.project, saved.buffers.size) && !isSessionLink(window.location.search)) {
          const kept = await saveProject(saved.project, saved.buffers, saved.workspace).catch(() => 'fail' as const)
          if (cancel) return
          if (kept !== 'ok') {
            restoreSaved(saved)
            store.toast('Could not store the last project, so it stays open.', 'warn')
            saveReady.current = true
            return
          }
        }
        store.loadProject(createEmptyProject(engine.sampleRate), new Map())
        store.setView('arrange')
        store.setTransportMode('arrangement')
        setSurface('studio')
        setPhonePane('edit')
        engine.seek(0)
        engine.sync(store.project, (id) => store.buffers.get(id))
        remember(NEW_PROJECT)
      } else if (saved) {
        restoreSaved(saved)
      }
      const params = new URLSearchParams(window.location.search)
      const performMode = params.get('perform')
      if (performMode === 'keys' || performMode === 'drums') {
        store.setView('arrange')
        const midi = store.project.tracks.find((track) => track.type === 'midi')
        if (midi) store.selectTrack(midi.id)
        setPerform(performMode)
        setVersion((value) => value + 1)
      }
      if (params.has('comp')) {
        store.seedCompPreview()
        store.setView('arrange')
        engine.sync(store.project, (id) => store.buffers.get(id))
        setVersion((value) => value + 1)
      }
      if (params.get('scaler') === '1' || params.get('library') === '1' || params.get('generate') === '1') {
        store.insertScaler(null, params.get('generate') === '1' ? 'write' : 'play')
        setVersion((value) => value + 1)
      }
      saveReady.current = true
    })()
    const schedule = () => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = 0
        write()
      }, 500)
    }
    const unsub = store.subscribe(schedule)
    const flush = () => {
      window.clearTimeout(timer)
      write(true)
      roomSave.current()
    }
    flushSave.current = flush
    const onVisible = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancel = true
      saveReady.current = false
      flushSave.current = () => {}
      unsub()
      window.clearTimeout(timer)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [store, engine])

  useEffect(() => {
    flushSave.current()
  }, [surface, phonePane])

  useEffect(() => {
    const code = session.state.code
    const id = session.state.selfId
    const role = session.state.role
    if (!code || !id || !role) return
    writeIdentity({
      participantId: id,
      name: session.state.name,
      role,
      code: '',
      camOn: session.state.camOn,
      micId: session.state.micId,
      outId: session.state.outId,
      musicOn: session.state.musicOn,
      jamEnabled: session.state.jamEnabled,
      jamDelayMs: session.state.jamDelayMs,
      monitorMode: session.state.monitorMode,
      transportMode: store.transportMode,
    })
    replaceInviteUrl()
  }, [session, store, version])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __cue?: { measure: () => ReturnType<AudioEngine['measureLiveHit']>; probe: () => ReturnType<AudioEngine['liveLatencyProbe']> } }).__cue = {
      measure: () => engine.measureLiveHit(),
      probe: () => engine.liveLatencyProbe(),
    }
  }, [engine])

  useEffect(() => {
    return session.subscribe(() => {
      setVersion((value) => value + 1)
      if (session.state.role === 'guest' && session.state.status === 'live') setSurface((current) => current)
      if (session.state.role === 'host') {
        for (const person of session.state.participants) {
          if (person.role === 'guest' && person.admitted && !armedPeers.current.has(person.id)) {
            armedPeers.current.add(person.id)
            store.ensureRemoteTrack(person.id, person.name)
            store.toast(`Added a track for ${person.name}. Arm it to record their take.`, 'good')
            session.publishArrangement()
            if (engine.status === 'playing' || engine.status === 'recording') {
              engine.refreshClockAnchor()
              session.broadcastTransport({
                action: 'play',
                timelineSample: Math.round(engine.currentTimelineSample()),
                hostPerfAtSample: performance.now(),
                mode: engine.currentMode(),
                tempo: store.project.tempo,
                launches: store.launched,
                launchAt: store.launchAt,
                launchGen: store.launchGen,
              })
            }
          }
        }
      }
      if (session.state.status === 'idle') store.remoteFollow = false
      else if (session.state.role === 'guest') store.remoteFollow = locksProject(session.state.role, session.selfAccess())
    })
  }, [session, store])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      // The row under the sheet is the menu's actions. Dismissing on
      // pointerdown removes New, Open, Save, and Export before click.
      if (target?.closest('.shell-menu, .menu-btn, .phone-context')) return
      setMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])

  useEffect(() => {
    const apply = () => {
      const next = formFactor(window.innerWidth, window.innerHeight)
      setForm(next)
      setLand(window.innerWidth > window.innerHeight)
      setSoundWidth((value) => clampSoundWidth(value, window.innerWidth, soundReserveRef.current))
      document.documentElement.classList.toggle('phone-root', next === 'phone')
      document.documentElement.dataset.form = next
    }
    apply()
    window.addEventListener('resize', apply)
    return () => {
      window.removeEventListener('resize', apply)
      document.documentElement.classList.remove('phone-root')
    }
  }, [])

  useEffect(() => {
    const unlock = () => {
      void engine.resume()
      document.querySelectorAll('video').forEach((node) => {
        void (node as HTMLVideoElement).play().catch(() => undefined)
      })
    }
    window.addEventListener('pointerdown', unlock)
    return () => window.removeEventListener('pointerdown', unlock)
  }, [engine])

  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    let gone = false
    const hold = async () => {
      if (gone || !('wakeLock' in navigator)) return
      if (session.state.status !== 'live' && engine.status === 'stopped') return
      try {
        lock = await navigator.wakeLock.request('screen')
      } catch {
        lock = null
      }
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void engine.resume()
      session.reviveMedia()
      void hold()
    }
    document.addEventListener('visibilitychange', onVisible)
    void hold()
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release()
    }
  }, [engine, session, session.state.status, engine.status, version])

  useEffect(() => {
    const applyPosture = () => {
      const vertical = window.matchMedia('(vertical-viewport-segments: 2)').matches
      const horizontal = window.matchMedia('(horizontal-viewport-segments: 2)').matches
      const folded = navigator.devicePosture?.type === 'folded'
      const landscape = window.innerWidth > window.innerHeight
      document.documentElement.dataset.posture = vertical || (folded && !landscape) ? 'tabletop' : horizontal || (folded && landscape) ? 'book' : 'flat'
    }
    applyPosture()
    const medias = ['(vertical-viewport-segments: 2)', '(horizontal-viewport-segments: 2)'].map((query) => window.matchMedia(query))
    medias.forEach((media) => media.addEventListener('change', applyPosture))
    navigator.devicePosture?.addEventListener('change', applyPosture)
    window.addEventListener('resize', applyPosture)
    return () => {
      medias.forEach((media) => media.removeEventListener('change', applyPosture))
      navigator.devicePosture?.removeEventListener('change', applyPosture)
      window.removeEventListener('resize', applyPosture)
    }
  }, [])

  useEffect(() => {
    const noteKeys: Record<string, number> = {
      KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65,
      KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71,
    }
    const midiTrack = () => store.project.tracks.find((item) => item.id === store.selectedTrackId && item.type === 'midi') ?? null
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = typingTarget(target)
      const command = historyCommand(event, typing)
      if (command) {
        event.preventDefault()
        if (command === 'undo') store.undo()
        else store.redo()
        return
      }
      if (typing) return
      const claimed = claimComputerKey({
        enabled: store.keyboardMidi,
        typing: false,
        meta: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        repeat: event.repeat,
        held: false,
        code: event.code,
        key: event.key,
      })
      if (claimed) return
      const key = event.key.toLowerCase()
      const meta = event.metaKey || event.ctrlKey
      const typed = noteKeys[event.code]
      if (store.keyboardMidi && typed != null && !meta && !event.repeat && !document.querySelector('.piano, .me-step, .drum-roll')) {
        const track = midiTrack()
        if (!track) return
        event.preventDefault()
        engine.unlock()
        engine.playThrough(track.id, typed, 0.8)
        return
      }
      if (key === 't' && !meta && !event.repeat && !store.keyboardMidi) {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('cueharbor-tap', { detail: performance.now() }))
      } else if (event.code === 'Space') {
        event.preventDefault()
        void play()
      } else if (key === 'r' && !meta) void record()
      else if (key === 'q' && !meta) store.quickQuantize()
      else if (meta && key === 's') {
        event.preventDefault()
        void persist()
      } else if (store.waveClipId && (((meta && key === 'e') || key === 'b') || deletesSelection(event.key, event.target))) {
        event.preventDefault()
      } else if ((meta && key === 'e') || key === 'b') store.splitSelected(engine.currentTimelineSample())
      else if (key === 'm' && !meta) {
        const track = store.project.tracks.find((item) => item.id === store.selectedTrackId)
        if (track && !store.remoteFollow) store.updateTrack(track.id, { mute: !track.mute })
      } else if (key === 's' && !meta) {
        const track = store.project.tracks.find((item) => item.id === store.selectedTrackId)
        if (track && !store.remoteFollow) store.updateTrack(track.id, { solo: !track.solo })
      } else if (deletesSelection(event.key, event.target)) {
        event.preventDefault()
        store.deleteSelectedClip()
      }
      else if (key === 'l' && !meta) store.toggle('loopEnabled')
      else if (event.key === 'Home' || event.key === 'Enter') void returnToStart()
      else if (event.key === '?' || (event.shiftKey && event.key === '/')) setHelp((open) => !open)
      else if (event.key === 'Escape') {
        if (help) {
          setHelp(false)
          return
        }
        if (menuOpen) {
          setMenuOpen(false)
          return
        }
        if (document.querySelector('.add-track-menu')) return
        if (editorPanel.current === 'piano' || editorPanel.current === 'pads' || editorPanel.current === 'steps') {
          event.preventDefault()
          void releaseOrientation()
          setKeysLandscape(false)
          const mark = editorPanel.current === 'piano' ? PIANO_HISTORY : editorPanel.current === 'steps' ? STEPS_HISTORY : PADS_HISTORY
          if (isHistoryMark(history.state, mark)) history.back()
          else if (editorPanel.current === 'piano') closePiano()
          else if (editorPanel.current === 'steps') store.closeSteps()
          else store.closePads()
          return
        }
        setHelp(false)
        setMenuOpen(false)
      }
      else if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('cueharbor-zoom', { detail: event.key === '-' ? 0.87 : 1.15 }))
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const beats = event.shiftKey ? store.project.timeSignature.numerator : 1
        const delta = beatsToSamples(beats, store.project.sampleRate, store.project.tempo) * (event.key === 'ArrowLeft' ? -1 : 1)
        void locate(engine.currentTimelineSample() + delta)
      }
    }
    const onUp = (event: KeyboardEvent) => {
      const typed = noteKeys[event.code]
      if (!store.keyboardMidi || typed == null) return
      const track = midiTrack()
      if (track) engine.releaseThrough(track.id, typed)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  })

  async function ready() {
    await engine.resume()
    if (engine.workletError && !workletWarned.current) {
      workletWarned.current = true
      store.toast('This browser did not start the audio worklets. Use a current Chrome, Edge, or iOS Safari so recording can run.', 'warn')
    }
    store.retargetSampleRate(engine.sampleRate)
    engine.sync(store.project, (id) => store.buffers.get(id))
    engine.setLaunches(store.launched)
  }

  async function play() {
    const decision = playPress(engine.status, store.project, engine.currentTimelineSample())
    if (decision.action === 'ignore') return
    if (decision.action === 'pause') {
      if (session.state.role === 'guest') {
        session.requestTransport({ action: 'stop' })
        return
      }
      engine.stop()
      session.broadcastTransport({ action: 'stop', timelineSample: Math.round(engine.positionSamples) })
      return
    }
    if (playStartsCapture(engine.status, recordReady.current, store.project.tracks)) {
      await record()
      return
    }
    await playFrom(decision.sample)
  }

  async function returnToStart() {
    if (startPress(engine.status).action === 'roll') {
      await playFrom(0)
      return
    }
    await locate(0)
  }

  async function playFrom(sample: number, mode: 'arrangement' | 'session' = 'arrangement', intent: 'play' | 'session-launch' = 'play') {
    if (session.state.role === 'guest') {
      session.requestTransport({ action: 'play', timelineSample: Math.round(sample), mode })
      return
    }
    void engine.resume()
    await ready()
    if (mode === 'arrangement') store.armArrangement()
    const lead = scheduleLeadMs(session.primaryOneWay()?.ms ?? 40)
    const counting = shouldCountIn({ enabled: store.project.countIn, stopped: engine.status === 'stopped', intent })
    const countMs = counting ? countInAt(store.project, sample) * 1000 : 0
    engine.refreshClockAnchor()
    const hostPerf = performance.now() + lead + countMs
    session.broadcastTransport({
      action: 'play',
      timelineSample: Math.round(sample),
      hostPerfAtSample: hostPerf,
      mode,
      tempo: tempoAtSample(store.project, sample),
      countIn: counting,
      countInMs: Math.round(countMs),
      countInBars: counting ? countInBarsOf(store.project) : 0,
      timeSignature: meterAtSample(store.project, sample),
      launches: store.launched,
      launchAt: store.launchAt,
      launchGen: store.launchGen,
    })
    if (counting) engine.armCountIn(tempoAtSample(store.project, sample), meterAtSample(store.project, sample), countInBarsOf(store.project))
    await engine.playAtPerf(sample, hostPerf, mode)
  }

  async function followPlay(cmd: Record<string, unknown>) {
    await ready()
    if (FEATURES.session && cmd.launches && typeof cmd.launches === 'object') {
      store.replaceSession({
        launched: cmd.launches as Record<string, string | null>,
        at: cmd.launchAt && typeof cmd.launchAt === 'object' ? (cmd.launchAt as Record<string, number>) : {},
        gen: cmd.launchGen && typeof cmd.launchGen === 'object' ? (cmd.launchGen as Record<string, number>) : {},
        mode: cmd.mode === 'session' ? 'session' : 'arrangement',
      }, engine.currentTimelineSample())
    }
    const counting = Boolean(cmd.countIn)
    const tempo = Number(cmd.tempo) || store.project.tempo
    const raw = cmd.timeSignature as { numerator?: number; denominator?: number } | undefined
    const signature = raw?.numerator && raw?.denominator
      ? { numerator: raw.numerator, denominator: raw.denominator }
      : store.project.timeSignature
    const localPerf = guestFollowStart({
      hostPerfAtSample: Number(cmd.hostPerfAtSample) || performance.now(),
      clockOffsetMs: session.hostOffsetMs(),
      oneWayMs: session.primaryOneWay()?.ms ?? 40,
      nowPerf: performance.now(),
      countInMs: counting ? Number(cmd.countInMs) || 0 : 0,
    })
    const mode = preferArrangeTransport(cmd.mode === 'session' ? 'session' : 'arrangement')
    if (counting) engine.armCountIn(tempo, signature, Number(cmd.countInBars) === 2 ? 2 : 1)
    await engine.playAtPerf(Number(cmd.timelineSample) || 0, localPerf, mode)
  }

  async function resetRoom() {
    if (session.state.role === 'guest') return
    if (session.state.role === 'host') session.broadcastTransport({ action: 'reset' })
    await applyLocalReset()
  }

  async function applyLocalReset() {
    pendingFollow.current = null
    if (punchTimer.current) {
      window.clearTimeout(punchTimer.current)
      punchTimer.current = 0
    }
    setRecordHint('')
    await session.applyLocalReset()
    store.clearToasts()
  }

  async function locate(sample: number) {
    const next = Math.max(0, Math.round(sample))
    if (session.state.role === 'guest') {
      session.requestTransport({ action: 'seek', timelineSample: next })
      return
    }
    if (engine.status === 'recording' || engine.status === 'counting-in') return
    if (engine.status === 'playing') {
      await playFrom(next)
      return
    }
    engine.seek(next)
    session.broadcastTransport({ action: 'seek', timelineSample: next })
  }

  async function stop() {
    recordEpoch.current += 1
    if (session.state.role === 'guest') {
      session.requestTransport({ action: 'stop' })
      return
    }
    const wasRecording = engine.status === 'recording'
    const decision = stopPress(engine.status, store.project, engine.currentTimelineSample())
    if (decision.action === 'home') {
      if (store.padRecord) store.endTake(Math.round(engine.currentTimelineSample()))
      await locate(decision.sample)
      return
    }
    if (engine.status === 'stopped') {
      if (store.padRecord) store.endTake(Math.round(engine.currentTimelineSample()))
      return
    }
    const end = Math.round(engine.currentTimelineSample())
    const captures = await engine.finishRecording()
    engine.stop()
    if (punchTimer.current) {
      window.clearTimeout(punchTimer.current)
      punchTimer.current = 0
    }
    const settings = store.recordSettings()
    const compensation = engine.latencyCompensationSamples()
    const punched = settings.punchEnabled ? punchWindow(settings, store.project.sampleRate, store.project.tempo, store.project.timeSignature) : null
    const cycling = Boolean(settings.loop && store.project.loopEnabled)
    for (const capture of captures) {
      const track = store.project.tracks.find((item) => item.id === capture.key)
        || store.project.tracks.find((item) => item.armed && (capture.peerId ? item.input === `remote:${capture.peerId}` : isLocalInput(item.input) || item.input.startsWith('mic:')))
      if (!track) continue
      const slot = store.sessionSlot
      const intoSlot = FEATURES.session && slot && slot.trackId === track.id && capture.source === 'local'
      if (intoSlot && slot) {
        const bufferId = uid('buf')
        store.addAsset({
          id: bufferId,
          name: capture.source === 'guide' ? 'Live guide' : 'Recording',
          sampleRate: capture.sampleRate,
          channels: capture.channels,
        })
        const durationSamples = recordedLength(capture.channels[0].length, store.project.recordBars ?? 0, capture.sampleRate, store.project.tempo, store.project.timeSignature)
        const clip: AudioClip = {
          id: uid('clip'),
          name: capture.source === 'guide' ? `${track.name} guide` : track.name,
          bufferId,
          startSample: 0,
          offsetSamples: 0,
          durationSamples,
          fadeInSamples: 64,
          fadeOutSamples: 128,
          gain: 1,
          source: capture.source === 'guide' ? 'guide' : 'local',
          peerId: capture.peerId,
          takeId: capture.takeId,
          durationBeats: samplesToBeats(durationSamples, capture.sampleRate, store.project.tempo),
          warp: true,
          loop: true,
          slotOnly: true,
          stretch: inspectClip(capture.channels[0] ?? new Float32Array(), capture.sampleRate, store.project.tempo),
        }
        store.placeInSlot(track.id, slot.scene, clip)
        if (capture.source === 'guide' && isSilentTake(capture.channels)) {
          store.toast(`${track.name} guide is silent. Video and the live mic need a connected media path. The aligned take replaces this if the upload arrives.`, 'warn')
        }
        continue
      }
      const length = capture.channels[0]?.length || 0
      const slices = sliceCapture({
        captureStart: capture.startSample,
        captureLength: length,
        compensation: capture.source === 'guide' ? 0 : compensation,
        punchFrom: punched ? punched.recordFrom : undefined,
        punchTo: punched ? punched.recordTo : undefined,
        loopStart: cycling ? store.project.loopStartSample : undefined,
        loopEnd: cycling ? store.project.loopEndSample : undefined,
      })
      if (!track || !slices.length) continue
      const makeLane = (slice: (typeof slices)[number], index: number): TakeLane => {
        const channels = capture.channels.map((channel) => channel.slice(slice.captureOffset, slice.captureOffset + slice.durationSamples))
        const bufferId = uid('buf')
        store.addAsset({
          id: bufferId,
          name: capture.source === 'guide' ? 'Live guide' : `Take ${index + 1}`,
          sampleRate: capture.sampleRate,
          channels,
        })
        return {
          id: uid('lane'),
          name: capture.source === 'guide' ? `${track.name} guide` : `${track.name} ${index + 1}`,
          bufferId,
          offsetSamples: 0,
          startSample: slice.startSample,
          durationSamples: channels[0]?.length || slice.durationSamples,
          peerId: capture.peerId,
          takeId: capture.takeId,
          source: capture.source === 'guide' ? 'guide' : 'local',
        }
      }
      if (slices.length > 1 || cycling) {
        slices.forEach((slice, index) => store.addTakeLane(track.id, makeLane(slice, index)))
        store.toast(`${track.name}: ${slices.length} take${slices.length === 1 ? '' : 's'} on the loop.`, 'good')
      } else {
        const lane = makeLane(slices[0], 0)
        const channels = store.buffers.get(lane.bufferId)?.channels || capture.channels
        const clip: AudioClip = {
          id: uid('clip'),
          name: capture.source === 'guide' ? `${track.name} guide` : track.name,
          bufferId: lane.bufferId,
          startSample: lane.startSample,
          offsetSamples: 0,
          durationSamples: lane.durationSamples,
          fadeInSamples: 64,
          fadeOutSamples: 128,
          gain: 1,
          source: lane.source,
          peerId: capture.peerId,
          takeId: capture.takeId,
          stretch: inspectClip(channels[0] ?? new Float32Array(), capture.sampleRate, store.project.tempo),
        }
        store.addAudioClip(track.id, clip)
        if (capture.source === 'local' && compensation > 0) {
          store.toast(`${track.name} aligned −${Math.round((compensation / engine.sampleRate) * 1000)} ms for monitoring delay.`, 'good')
        }
        if (capture.source === 'guide' && isSilentTake(channels)) {
          store.toast(`${track.name} guide is silent. Video and the live mic need a connected media path. The aligned take replaces this if the upload arrives.`, 'warn')
        }
      }
    }
    if (settings.quick) store.setRecord({ quick: false, punchEnabled: false })
    if (takeRef.current) {
      session.broadcastTransport({ action: 'record-stop', takeId: takeRef.current.id, timelineSample: end })
      takeRef.current = null
    }
    session.broadcastTransport({ action: 'stop', timelineSample: end })
    store.endTake(end)
    if (wasRecording) {
      recordReady.current = false
      versionSave.current('record')
    }
  }

  async function rememberVersion(reason: VersionReason) {
    if (isUntouchedEmpty(store.project) && store.buffers.size === 0) return
    const at = Date.now()
    const digest = digestProject(store.project)
    const listed = await listVersions(store.project.id).catch(() => [])
    const last = listed[0]
    if (!shouldSaveVersion({ reason, lastAt: last?.at ?? null, now: at, digest, lastDigest: last?.digest ?? null })) return
    let storedName = ''
    try { storedName = localStorage.getItem('cueharbor-name') || '' } catch { storedName = '' }
    const by = session.state.name || storedName || 'You'
    const result = await saveVersion({
      id: uid('ver'),
      projectId: store.project.id,
      roomCode: session.state.code || '',
      name: versionTitle(reason, at),
      by,
      at,
      reason,
      digest,
      project: musicalClone(store.project),
    }).catch(() => 'fail' as const)
    if (result !== 'ok') return
    if (reason !== 'timer') store.toast(reason === 'record' ? 'Saved a recording version' : 'Saved a version')
    setVersionTick((value) => value + 1)
  }

  async function saveSharedRoom() {
    const code = session.state.code
    const role = session.state.role
    if (!code || (role !== 'host' && role !== 'guest') || !session.sharesRoom()) return
    const copy = buildRoomCopy({
      code,
      role,
      name: session.state.name || 'Guest',
      savedAt: Date.now(),
      project: store.project,
      journal: store.sync.snapshot(),
    })
    const result = await saveRoomCopy(copy).catch(() => 'fail' as const)
    if (result === 'ok') session.markRoomSaved(copy.savedAt, role)
    if (result === 'quota') store.toast('This browser is out of space, so the room copy could not be kept.', 'warn')
  }

  versionSave.current = (reason) => {
    void rememberVersion(reason)
  }
  roomSave.current = () => {
    void saveSharedRoom()
  }

  function openPerform(mode: 'keys' | 'drums') {
    if (mode === 'drums') {
      hideCollab()
      setSurface('studio')
      setPhonePane('edit')
      setMenuOpen(false)
      setPianoOpen(false)
      const midi = store.project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
        || store.project.tracks.find((track) => track.type === 'midi')
      store.insertPads(midi?.id ?? null)
      return
    }
    engine.unlock()
    void engine.resume()
    const midi = store.project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
      || store.project.tracks.find((track) => track.type === 'midi')
    if (midi) {
      store.selectTrack(midi.id)
      if (!midi.midiClips.length) store.addMidiClip(midi.id, 0)
      else if (!store.selectedMidiClipId) store.selectClip(midi.id, midi.midiClips[0].id, true)
    }
    setPerform(mode)
    setSurface('studio')
    setPhonePane('edit')
  }

  async function quickPunch() {
    if (session.state.role === 'guest') {
      store.toast('The host records. Your take still lands on their timeline.', 'info')
      return
    }
    const recording = engine.status === 'recording'
    store.quickPunch(Math.round(engine.currentTimelineSample()), recording)
    if (recording) await stop()
    else await record()
  }

  function prepareBeatRecord() {
    if (engine.status === 'recording' || engine.status === 'counting-in') return
    const selected = store.selectedTrackId ? store.track(store.selectedTrackId) : null
    const id = store.padsTrackId
      ?? (selected && (selected.instrument === 'pads' || selected.instrument === 'drum-machine') ? selected.id : null)
    if (!id) return
    store.armPadRecord(id, projectSampleBeat(store.project, engine.positionSamples))
  }

  async function record() {
    if (session.state.role === 'guest') {
      store.toast('The host records. Your take still lands on their timeline.', 'info')
      return
    }
    engine.unlock()
    void engine.resume()
    if (engine.status === 'recording' || engine.status === 'counting-in') {
      recordReady.current = false
      await stop()
      return
    }
    const epoch = ++recordEpoch.current
    prepareBeatRecord()
    const decision = recordPress(engine.status, store.project.tracks, recordReady.current)
    if (decision === 'stop') {
      recordReady.current = false
      await stop()
      return
    }
    if (decision === 'disarm') {
      recordReady.current = false
      if (store.padRecord) store.finishPadRecord(null)
      setRecordHint('')
      return
    }
    if (decision === 'arm') {
      recordReady.current = true
      if (store.padRecord) store.finishPadRecord(null)
      setRecordHint('Arm a track to record.')
      window.setTimeout(() => setRecordHint(''), 2800)
      return
    }
    recordReady.current = true
    const slot = FEATURES.session ? store.sessionSlot : null
    const slotTrack = slot ? store.project.tracks.find((track) => track.id === slot.trackId) : undefined
    const intoSlot = Boolean(slot && slotTrack && (slotTrack.type === 'audio' || slotTrack.type === 'midi'))
    if (slot && slotTrack?.type === 'midi' && slotTrack.armed) store.prepareMidiSlot(slot.trackId, slot.scene)
    if (intoSlot && slotTrack?.armed && store.transportMode !== 'session') store.enterSession()
    await ready()
    if (epoch !== recordEpoch.current) return
    const takeId = uid('take')
    const inputs = await collectRecordInputs({
      tracks: store.project.tracks,
      takeId,
      localStream: () => session.localPerformanceStream(),
      remoteStream: (peerId) => session.remoteMusic(peerId),
      setLocalMic: (stream) => engine.setLocalMic(stream),
      openMic: (audio) => navigator.mediaDevices.getUserMedia({ audio, video: false }),
    })
    if (epoch !== recordEpoch.current) return
    const midiArmed = armedRecordPlan(store.project.tracks).midi.length > 0
    if (!inputs.length && !midiArmed) {
      if (store.padRecord) store.finishPadRecord(null)
      setRecordHint('Arm a track to record.')
      window.setTimeout(() => setRecordHint(''), 2800)
      return
    }
    const settings = store.recordSettings()
    const punched = settings.punchEnabled ? punchWindow(settings, store.project.sampleRate, store.project.tempo, store.project.timeSignature) : null
    const alreadyPlaying = engine.status === 'playing'
    const transportMode = FEATURES.session && (intoSlot || store.transportMode === 'session' || engine.currentMode() === 'session') ? 'session' : 'arrangement'
    let fromSample = Math.round(engine.currentTimelineSample())
    if (!alreadyPlaying && punched) fromSample = punched.playFrom
    const counting = shouldCountIn({ enabled: store.project.countIn, stopped: !alreadyPlaying, intent: 'record' })
    const lead = scheduleLeadMs(session.primaryOneWay()?.ms ?? 40)
    const countMs = counting ? countInAt(store.project, fromSample) * 1000 : 0
    engine.refreshClockAnchor()
    const hostPerf = performance.now() + lead + countMs
    if (!alreadyPlaying) {
      session.broadcastTransport({
        action: 'play',
        timelineSample: fromSample,
        hostPerfAtSample: hostPerf,
        mode: transportMode,
        tempo: tempoAtSample(store.project, fromSample),
        countIn: counting,
        countInMs: Math.round(countMs),
        countInBars: counting ? countInBarsOf(store.project) : 0,
        timeSignature: meterAtSample(store.project, fromSample),
      })
    }
    if (epoch !== recordEpoch.current) return
    await engine.beginRecord({
      fromSample,
      inputs,
      countIn: counting,
      hostPerfAtSample: alreadyPlaying ? undefined : hostPerf,
      mode: transportMode,
      onPunch: (info) => {
        if (slot && slotTrack?.type === 'midi') {
          store.sessionRecordBeat = samplesToBeats(info.timelineSample, store.project.sampleRate, store.project.tempo)
        }
        takeRef.current = { id: takeId, endSample: info.timelineSample }
        store.beginTake(info.timelineSample)
        if (punched) {
          const remain = (punched.stopAt - info.timelineSample) / engine.sampleRate
          if (punchTimer.current) window.clearTimeout(punchTimer.current)
          punchTimer.current = window.setTimeout(() => { void stop() }, Math.max(80, remain * 1000))
        }
        session.broadcastTransport({
          action: 'record-start',
          takeId,
          timelineSample: info.timelineSample,
          cueEpochHostPerfMs: info.cueEpochHostPerf,
          sampleRate: engine.sampleRate,
          tempo: store.project.tempo,
          oneWayHintMs: session.primaryOneWay()?.ms ?? 0,
        })
      },
    })
  }

  function workspaceNow(): WorkspaceSnapshot {
    return {
      view: preferArrangeView(store.view),
      transportMode: preferArrangeTransport(store.transportMode),
      positionSamples: Math.round(engine.positionSamples),
      selectedTrackId: store.selectedTrackId,
      surface,
      phonePane,
    }
  }

  async function persist() {
    const stamp = store.editStamp()
    const result = await saveProject(store.project, store.buffers, workspaceNow(), { snapshot: true })
    if (result === 'ok') store.markSaved(stamp)
    store.toast(result === 'quota' ? 'This browser is out of space, so the project could not be kept.' : 'Saved in this browser.', result === 'quota' ? 'warn' : 'good')
  }

  function beginNewProject() {
    setMenuOpen(false)
    if (store.remoteFollow) return
    if (needsNewProjectConfirm(store.hasUnsavedEdits())) {
      const discard = window.confirm('This project has unsaved changes. Start a new project without saving them?')
      if (!discard) return
    }
    if (engine.status !== 'stopped') engine.stop()
    store.loadProject(createEmptyProject(engine.sampleRate), new Map())
    store.setView('arrange')
    store.setTransportMode('arrangement')
    setSurface('studio')
    engine.seek(0)
    engine.sync(store.project, (id) => store.buffers.get(id))
    try { sessionStorage.setItem(TAB_PROJECT, NEW_PROJECT) } catch { /* private mode keeps the in-memory project */ }
  }

  async function openProjects() {
    setDraftName(store.project.name)
    setProjects(await listProjects())
    setSnapshots(await listSnapshots(store.project.id))
    const report = await storageReport()
    setUsage(formatBytes(report.used))
    setPersisted(report.persisted)
    setProjectsOpen(true)
    void requestPersistentStorage()
  }

  function joinCollab(input: { name: string; code: string; invite: string }) {
    engine.unlock()
    session.primeMediaFromGesture()
    const name = input.name.trim() || joinName || 'Artist'
    setJoinName(name)
    session.connect({ name, code: input.code, invite: input.invite })
  }

  function saveAs(name: string) {
    const copy = JSON.parse(JSON.stringify(store.project)) as typeof store.project
    copy.id = uid('prj')
    copy.name = name || store.project.name
    const buffers = new Map(store.buffers)
    void saveProject(copy, buffers, workspaceNow(), { snapshot: true }).then(() => {
      store.loadProject(copy, buffers)
      void openProjects()
    })
  }

  async function dropOnSlot(trackId: string, scene: number, file: File) {
    const track = store.project.tracks.find((item) => item.id === trackId)
    if (!track || track.type !== 'audio') {
      store.toast('Drop audio onto an audio track.', 'warn')
      return
    }
    await ready()
    if (!engine.ctx) return
    const decoded = await engine.ctx.decodeAudioData((await file.arrayBuffer()).slice(0))
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice())
    const bufferId = uid('buf')
    store.addAsset({ id: bufferId, name: file.name, sampleRate: decoded.sampleRate, channels })
    store.placeInSlot(trackId, scene, {
      id: uid('clip'),
      name: file.name.replace(/\.[^.]+$/, '') || file.name,
      bufferId,
      startSample: 0,
      offsetSamples: 0,
      durationSamples: decoded.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      loop: true,
      slotOnly: true,
      warp: true,
      durationBeats: samplesToBeats(decoded.length, decoded.sampleRate, store.project.tempo),
      stretch: inspectClip(channels[0] ?? new Float32Array(), decoded.sampleRate, store.project.tempo),
    })
  }

  async function importAsInstrument(trackId: string, files: FileList | File[]) {
    await ready()
    if (!engine.ctx) return
    for (const file of files) {
      try {
        const decoded = await engine.ctx.decodeAudioData((await file.arrayBuffer()).slice(0))
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice())
        store.loadSamplerSound(trackId, {
          id: uid('smp'),
          name: file.name.replace(/\.[^.]+$/, '') || file.name,
          sampleRate: decoded.sampleRate,
          channels,
        })
      } catch (error) {
        store.toast(error instanceof Error ? error.message : 'Could not read that audio file.', 'warn')
      }
    }
  }

  async function importAudio(files: FileList | null) {
    if (!files?.length) return
    const selected = store.project.tracks.find((item) => item.id === store.selectedTrackId)
    if (selected?.type === 'midi') {
      await importAsInstrument(selected.id, files)
      return
    }
    await ready()
    const track = selected?.type === 'audio' ? selected : store.project.tracks.find((item) => item.type === 'audio')
    if (!track || !engine.ctx) return
    for (const file of files) {
      const decoded = await engine.ctx.decodeAudioData((await file.arrayBuffer()).slice(0))
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice())
      const bufferId = uid('buf')
      store.addAsset({ id: bufferId, name: file.name, sampleRate: decoded.sampleRate, channels })
      store.addAudioClip(track.id, {
        id: uid('clip'),
        name: file.name,
        bufferId,
        startSample: Math.round(engine.positionSamples),
        offsetSamples: 0,
        durationSamples: decoded.length,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: 1,
        source: 'import',
        stretch: inspectClip(channels[0] ?? new Float32Array(), decoded.sampleRate, store.project.tempo),
      })
    }
  }

  async function importProject(file: File | null) {
    if (!file) return
    const loaded = await unpackProject(new Uint8Array(await file.arrayBuffer()))
    const buffers = new Map(loaded.assets.map((asset) => [asset.id, asset]))
    store.loadProject(loaded.project, buffers)
    await ready()
  }

async function importDropped(files: FileList) {
    const list = [...files]
    const projectFile = list.find((file) => /\.cueharbor$|\.json$/i.test(file.name))
    if (projectFile) {
      await importProject(projectFile)
      return
    }
    const transfer = new DataTransfer()
    for (const file of list) transfer.items.add(file)
    await importAudio(transfer.files)
  }

  const panel: 'room' | 'piano' | 'rack' | 'scaler' | 'pads' | 'steps' =
    surface !== 'studio' || phonePane === 'room' ? 'room'
    : store.stepTrackId ? 'steps'
    : store.padsTrackId ? 'pads'
    : store.scalerTrackId ? 'scaler'
    : pianoOpen ? 'piano'
    : store.rackTrackId ? 'rack'
    : 'room'
  const pianoTrack = store.project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
    || store.project.tracks.find((track) => track.type === 'midi')
  editorPanel.current = panel
  useEffect(() => {
    publishAwareness.current()
  }, [panel])
  useEffect(() => {
    if (panel !== 'piano' || phone) return
    setDock(pianoDockWidth(window.innerWidth))
  }, [panel, phone])
  const studioTab: StudioTab = collabOpen ? 'collab' : editorView
  const collabShown = collabPanelVisible(studioTab)
  const dockShown = !collabShown && dockVisible({ surface, panel, dockOpen: false })
  useLayoutEffect(() => {
    syncPhoneSheetFrame(shellRef.current)
  }, [collabShown, panel, editorView, phone, land])
  useLayoutEffect(() => {
    if (panel !== 'pads' && panel !== 'steps') return
    const place = () => alignPluginClose(shellRef.current)
    place()
    const observer = new ResizeObserver(place)
    if (shellRef.current) observer.observe(shellRef.current)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [panel, phone, land, form])
  const soundReserve = !phone && dockShown && dockEdge === 'right' ? dock : 0
  soundReserveRef.current = soundReserve
  useEffect(() => {
    setSoundWidth((value) => clampSoundWidth(value, window.innerWidth, soundReserve))
  }, [soundReserve])
  const waitingGuests = session.state.participants.filter((person) => !person.admitted && person.role !== 'host').length
  const collabBadge = collabBadgeOn({
    tab: studioTab,
    status: session.state.status,
    pendingInvite: false,
    waiting: waitingGuests,
  })

  function hideCollab() {
    writeSessionDock(false)
    setCollabOpen(false)
    setPhonePane('edit')
  }

  function dismissForTab() {
    onViewTab({
      keyboardOpen: store.keyboardMidi || keysLandscape,
      orientationLocked: keysMode.current === 'locked',
      releaseOrientation: () => { void releaseOrientation() },
      hideKeyboard: () => {
        if (store.keyboardMidi) {
          store.clearKeyboardReturn()
          store.setKeyboardMidi(false)
          notifyKeyboard(false)
        }
        setKeysLandscape(false)
      },
    })
  }

  function showCollab() {
    dismissForTab()
    writeSessionDock(true)
    setCollabOpen(true)
    setSurface('studio')
    setPhonePane('edit')
  }

  function showView(view: 'arrange' | 'mix' | 'beats' | 'session') {
    const next = preferArrangeView(view)
    dismissForTab()
    hideCollab()
    setSurface('studio')
    store.setView(next)
  }

  function closePiano() {
    setPianoOpen(false)
    store.closePiano()
  }

  const shownEditor: EditorHistoryMark | null = panel === 'piano' ? PIANO_HISTORY : panel === 'pads' ? PADS_HISTORY : panel === 'steps' ? STEPS_HISTORY : null
  useEffect(() => {
    const previous = editorHistory.current
    const step = editorHistoryStep(previous, shownEditor)
    editorHistory.current = shownEditor
    let cancel = false
    let removePop = () => {}
    // A track sheet closes with history.back(). That popstate arrives after this
    // effect. Pushing the editor first lets the sheet pop remove it and close the panel.
    const apply = () => {
      if (cancel) return
      if (step === 'push' && shownEditor) history.pushState({ cueharbor: shownEditor }, '')
      else if (step === 'replace' && shownEditor) {
        if (isHistoryMark(history.state, previous ?? '')) history.replaceState({ cueharbor: shownEditor }, '')
        else history.pushState({ cueharbor: shownEditor }, '')
      } else if (step === 'back' && previous && isHistoryMark(history.state, previous)) {
        ignorePop.current += 1
        history.back()
      }
      if (!shownEditor) return
      const onPop = () => {
        editorHistory.current = null
        setKeysLandscape(false)
        void releaseOrientation()
        if (shownEditor === PIANO_HISTORY) closePiano()
        else if (shownEditor === STEPS_HISTORY) store.closeSteps()
        else store.closePads()
      }
      window.addEventListener('popstate', onPop)
      removePop = () => window.removeEventListener('popstate', onPop)
    }
    const pending = sheetHistoryPop()
    if (pending) void pending.then(apply)
    else apply()
    return () => {
      cancel = true
      removePop()
    }
  }, [shownEditor])

  useEffect(() => {
    const orient = typeof screen === 'undefined' ? undefined : screen.orientation
    if (!orient?.addEventListener) return
    const onChange = () => {
      setScreenAngle(orient.angle)
      if (!holdLandscape.current) return
      const report = { type: orient.type, angle: orient.angle }
      if (!keepLandscapeAfterClose(true, report)) {
        holdLandscape.current = false
        setKeysLandscape(false)
      }
    }
    setScreenAngle(orient.angle)
    orient.addEventListener('change', onChange)
    return () => orient.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onPop = () => {
      if (ignorePop.current > 0) {
        ignorePop.current -= 1
        return
      }
      setKeysLandscape(false)
      void releaseOrientation()
      if (store.keyboardMidi) {
        store.clearKeyboardReturn()
        store.setKeyboardMidi(false)
        notifyKeyboard(false)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [store])

  function landscapeHost() {
    return browserLandscapeHost(shellRef.current, form, window.innerHeight >= window.innerWidth)
  }

  async function settleKeyboard(on: boolean) {
    const generation = ++settleGen.current
    if (!on || form !== 'phone') {
      const follow = await dismissKeyboard(landscapeHost(), keysMode.current)
      if (generation !== settleGen.current) return
      keysMode.current = 'dock'
      holdLandscape.current = follow.holdLandscape
      const orient = typeof screen === 'undefined' ? undefined : screen.orientation
      const still = keepLandscapeAfterClose(follow.holdLandscape, orient ? { type: orient.type, angle: orient.angle } : null)
      setKeysLandscape(false)
      if (!still) holdLandscape.current = false
      return
    }
    const mode = await presentKeyboard(landscapeHost())
    if (generation !== settleGen.current) {
      if (mode === 'locked') await releaseOrientation()
      return
    }
    keysMode.current = mode
    holdLandscape.current = false
    setKeysLandscape(mode === 'shell')
  }

  useEffect(() => {
    setKeyboardPresenter((on) => {
      keysFromClick.current = true
      void settleKeyboard(on)
    })
    return () => setKeyboardPresenter(null)
  }, [form])

  useEffect(() => {
    setPianoHider(() => setPianoOpen(false))
    return () => setPianoHider(null)
  }, [])

  useEffect(() => {
    const track = store.project.tracks.find((item) => item.id === store.selectedTrackId)
    if (!shouldCloseOnscreenPiano(track, store.keyboardMidi)) return
    store.clearKeyboardReturn()
    store.setKeyboardMidi(false)
    notifyKeyboard(false)
  }, [store, version])

  useEffect(() => {
    if (keysFromClick.current) {
      keysFromClick.current = false
      return
    }
    let cancel = false
    void (async () => {
      if (cancel) return
      await settleKeyboard(store.keyboardMidi)
    })()
    return () => {
      cancel = true
    }
  }, [store.keyboardMidi, form])

  function openStepSequencer(trackId: string) {
    hideCollab()
    setSurface('studio')
    setPhonePane('edit')
    setMenuOpen(false)
    setPianoOpen(false)
    store.closePiano()
    store.closePads()
    store.clearKeyboardReturn()
    if (store.keyboardMidi) {
      store.setKeyboardMidi(false)
      notifyKeyboard(false)
    }
    store.openSteps(trackId)
  }

  function closeStepSequencer() {
    store.closeSteps()
    setKeysLandscape(false)
    void releaseOrientation()
  }

  function onTrackAdded(id: string, choice: TrackChoice) {
    hideCollab()
    setSurface('studio')
    setPhonePane('edit')
    store.setView('arrange')
    if (choice !== 'steps') store.closeSteps()
    if (choice !== 'pads') store.closePads()
    if (choice === 'instrument') openKeyboard(id)
    else if (choice === 'pads') openBeatMachine(id)
    else if (choice === 'steps') openStepSequencer(id)
    else {
      setPianoOpen(false)
      if (store.keyboardMidi) store.setKeyboardMidi(false)
    }
  }

  function openBeatMachine(trackId: string) {
    hideCollab()
    setSurface('studio')
    setPhonePane('edit')
    setMenuOpen(false)
    setPianoOpen(false)
    store.selectTrack(trackId)
    store.clearKeyboardReturn()
    if (store.keyboardMidi) {
      store.setKeyboardMidi(false)
      notifyKeyboard(false)
    }
    store.showPads(trackId)
  }

  function openBeatKeyboard() {
    const trackId = store.padsTrackId
    if (!trackId) return
    engine.unlock()
    setPianoOpen(false)
    store.openKeyboardForPads(trackId)
    notifyKeyboard(true)
  }

  function openKeyboard(trackId: string) {
    const track = store.project.tracks.find((item) => item.id === trackId)
    if (!track) return
    const surface = editorForGesture('select-track', track.type, track)
    if (surface === 'pads') {
      openBeatMachine(trackId)
      return
    }
    if (surface === 'steps') {
      openStepSequencer(trackId)
      return
    }
    if (surface !== 'keyboard') return
    store.clearKeyboardReturn()
    store.setKeyboardMidi(true)
    setPianoOpen(false)
  }

  function editNotes() {
    const selected = store.project.tracks.find((item) => item.id === store.selectedTrackId)
    const clipTrack = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
    const track = selected?.type === 'midi' ? selected : clipTrack
    if (!track || editorForGesture('edit-notes', track.type) !== 'piano') return
    const clipId = track.midiClips.some((clip) => clip.id === store.selectedMidiClipId) ? store.selectedMidiClipId ?? undefined : undefined
    openPiano(track.id, clipId)
  }

  function openPiano(trackId: string, clipId?: string) {
    if (releaseKeyboardForPiano(store)) notifyKeyboard(false)
    store.closeScaler()
    store.closePads()
    const project = store.project
    let sample = engine.positionSamples
    if (project.loopEnabled && (sample < project.loopStartSample || sample >= project.loopEndSample)) sample = project.loopStartSample
    const beat = samplesToBeats(sample, project.sampleRate, project.tempo)
    store.preparePianoClip(trackId, beat, clipId)
    setSurface('studio')
    setPhonePane('edit')
    store.setView('arrange')
    setPianoOpen(true)
  }

  function openPlugin(page: 'play' | 'write') {
    hideCollab()
    setSurface('studio')
    setPhonePane('edit')
    setMenuOpen(false)
    store.insertScaler(pianoTrack?.id ?? null, page)
  }

  useScreenOverlay(() => setExportOpen(false), exportOpen)
  useScreenOverlay(() => setHelp(false), help)
  useScreenOverlay(() => setProjectsOpen(false), projectsOpen)
  useScreenOverlay(() => setTuneOpen(false), tuneOpen)
  useScreenOverlay(() => setKnockOpen(false), knockOpen)
  useScreenOverlay(() => { engine.stopPreview(); setUnstuckOpen(false) }, unstuckOpen)
  const shellOpen = soundsOpen && surface === 'studio' && (collabShown || editorView !== 'arrange')
  const shellPhase = usePushPhase(shellOpen)
  useScreenOverlay(() => setAnalysisTrackId(null), analysisTrackId != null)
  useScreenOverlay(() => setPerform(null), perform != null)
  useScreenOverlay(() => { setPianoOpen(false); store.closePiano() }, pianoOpen)
  useScreenOverlay(() => {
    store.clearKeyboardReturn()
    store.setKeyboardMidi(false)
    notifyKeyboard(false)
  }, store.keyboardMidi)
  useScreenOverlay(() => store.closeSteps(), store.stepTrackId != null)
  useScreenOverlay(() => store.closePads(), store.padsTrackId != null)
  useScreenOverlay(() => store.closeScaler(), store.scalerTrackId != null)
  useScreenOverlay(() => store.focusPlugin(null), store.pluginFocus != null)
  useScreenOverlay(() => store.closeQuantize(), store.quantizeOpen)
  useScreenOverlay(() => { if (store.patchTrackId) store.openPatch(store.patchTrackId) }, store.patchTrackId != null)
  useScreenOverlay(() => store.closeStems(), store.stemTrackId != null)
  useScreenOverlay(() => store.closeSpectral(), store.spectralTrackId != null)
  useScreenOverlay(() => store.closeClipSheet(), store.clipSheet)

  const phoneArrange = phone && surface === 'studio' && !collabShown && phonePane !== 'room' && editorView === 'arrange' && panel !== 'piano'
  const transportShown = (surface === 'studio' || surface === 'artist' || session.state.status === 'live') && (!collabShown || (phone && !land))
  const phonePlace: PhonePlace = collabShown
    ? 'collab'
    : panel === 'pads' || panel === 'steps' || panel === 'scaler' || panel === 'piano' || panel === 'rack'
      ? 'plugin'
      : editorView === 'mix'
        ? 'mix'
        : surface === 'studio' && editorView === 'arrange'
          ? 'arrange'
          : 'other'
  const menuButton = (
    <button ref={menuButtonRef} type="button" className={`menu-btn ${menuOpen ? 'on' : ''}`} aria-label="Menu. Project, edit, view, and settings." title="Project, edit, view, and settings." aria-expanded={menuOpen} aria-controls="shell-menu" onClick={() => setMenuOpen((open) => !open)}>
      <MenuIcon />
      <span className="menu-word">Menu</span>
    </button>
  )
  const historyButtons = (
    <HistoryButtons canUndo={store.canUndo} canRedo={store.canRedo} onUndo={() => store.undo()} onRedo={() => store.redo()} />
  )
  function openIdeas(page: IdeasPage) {
    setMenuOpen(false)
    if (unstuckOpen && page !== ideasPage) engine.stopPreview()
    setIdeasPage(page)
    setUnstuckOpen(true)
  }
  function toggleIdeas() {
    setMenuOpen(false)
    if (unstuckOpen) {
      engine.stopPreview()
      setUnstuckOpen(false)
      return
    }
    setIdeasPage('write')
    setUnstuckOpen(true)
  }
  const ideasButton = (
    <button
      type="button"
      className={`ideas-bulb${unstuckOpen ? ' on' : ''}`}
      aria-label="Ideas"
      title="Ideas"
      aria-pressed={unstuckOpen}
      disabled={store.remoteFollow}
      onClick={toggleIdeas}
    >
      <IdeasBulbIcon />
    </button>
  )

  if (new URLSearchParams(window.location.search).get('faces') === '1') {
    return (
      <Suspense fallback={null}>
        <FaceGallery />
      </Suspense>
    )
  }

  return (
    <TransportActionContext.Provider value={{
      record: () => { engine.unlock(); void record() },
      stop: () => { void stop() },
      play: () => { engine.unlock(); void play() },
    }}>
    <div
      ref={shellRef}
      className={`shell ${surface} ${phone ? 'phone' : ''} ${form === 'fold' ? 'fold' : ''} ${land ? 'land' : ''} ${phoneArrange ? 'phone-arrange' : ''} ${phonePane === 'room' && surface === 'studio' ? 'room' : ''} ${store.keyboardMidi ? 'keys-open' : ''} ${keysLandscape && keyboardShellTurn(screenAngle) === 'upside-down' ? 'orient-180' : ''} ${keysLandscape && keyboardShellTurn(screenAngle) !== 'upside-down' ? 'keys-landscape' : ''}`}
      style={{ ['--dock' as string]: `${dock}px`, ['--sounds' as string]: `${soundWidth}px` }}
      data-version={version}
      data-form={form}
      data-session-dock="closed"
      data-collab={collabShown ? 'open' : 'closed'}
      data-dock={dockShown ? 'open' : 'closed'}
      data-editor={dockShown ? panel : 'none'}
      data-plugin={dockShown && (panel === 'scaler' || panel === 'pads' || panel === 'steps') ? panel : 'none'}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer.files.length) void importDropped(event.dataTransfer.files)
      }}
    >
      <div className={phone && !land ? 'phone-top' : 'chrome-stack'}>
      <header className="topbar">
        {!phone && menuButton}
        {!phone && (
          <div className="brand">
            <div className="mark" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 18 18">
                <path d="M2 12c2-4 3.4-6 7-6s5 2 7 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="9" cy="5.5" r="1.3" fill="currentColor" />
              </svg>
            </div>
            <h1>CueHarbor</h1>
          </div>
        )}
        {!phone && (
          <input className="project-name" aria-label="Project name" value={store.project.name} onChange={(event) => store.renameProject(event.target.value)} />
        )}
        <ViewSwitcher
          active={surface === 'studio' ? editorView : null}
          collabShown={collabShown}
          phonePane={phonePane}
          collabBadge={collabBadge}
          onView={showView}
          onCollab={showCollab}
        />
        {!phone && historyButtons}
        {!phone && !transportShown && ideasButton}
        <AnchoredMenu fill sheet={phone} open={menuOpen} onClose={() => setMenuOpen(false)} label="Project menu" triggerRef={menuButtonRef} prefer="down">
          <MainMenu
            items={visibleMenu({
              phone,
              session: store.transportMode === 'session',
              dockBottom: dockEdge === 'bottom',
              hardwareMidi: !hidesHardwareMidi(navigator.userAgent),
            })}
            pressed={(action) => action === 'box' || action === 'erase' || action === 'pan' ? activeTool() === action
              : action === 'snap' ? store.project.snap
              : action === 'loop' ? store.project.loopEnabled
              : false}
            disabled={(action) => store.remoteFollow && (action === 'new' || action === 'session-mode' || action === 'capture' || action === 'snap' || action === 'loop' || action === 'signature' || action === 'box' || action === 'erase' || action === 'pan')}
            signature={`${store.project.timeSignature.numerator}/${store.project.timeSignature.denominator}`}
            onSignature={(numerator, denominator) => store.setTimeSignature(numerator, denominator)}
            projectName={phone ? store.project.name : undefined}
            onProjectName={phone ? (name) => store.renameProject(name) : undefined}
            canUndo={store.canUndo}
            canRedo={store.canRedo}
            onUndo={phone ? () => { setMenuOpen(false); store.undo() } : undefined}
            onRedo={phone ? () => { setMenuOpen(false); store.redo() } : undefined}
            onIdeas={phone && !transportShown ? () => openIdeas('write') : undefined}
            latencyHint={latencyHint}
            latencyReadout={latencyReadout}
            onLatency={(hint) => {
              setLatencyHint(hint)
              void engine.setLatencyChoice(hint).then((readout) => setLatencyReadout(readout))
            }}
            onAction={(action) => {
              if (action === 'new') beginNewProject()
              else if (action === 'open') { setMenuOpen(false); void openProjects() }
              else if (action === 'save') { setMenuOpen(false); void persist() }
              else if (action === 'export') { setMenuOpen(false); setExportOpen(true) }
              else if (action === 'box' || action === 'erase' || action === 'pan') { setMenuOpen(false); store.setTool(action) }
              else if (action === 'quantize') { setMenuOpen(false); store.openQuantize() }
              else if (action === 'to-start') { setMenuOpen(false); void returnToStart() }
              else if (action === 'loop') store.toggle('loopEnabled')
              else if (FEATURES.session && action === 'session-mode') {
                setMenuOpen(false)
                hideCollab()
                setSurface('studio')
                if (store.transportMode === 'session') store.backToArrangement()
                else store.enterSession()
              } else if (FEATURES.session && action === 'capture') { setMenuOpen(false); store.captureToArrangement() }
              else if (action === 'dock') setDockEdge(dockEdge === 'right' ? 'bottom' : 'right')
              else if (action === 'scaler') openPlugin('play')
              else if (action === 'players') { setPhonePane('edit'); setSurface('studio'); openIdeas('players') }
              else if (action === 'midi') {
                setMenuOpen(false)
                setSoundsOpen(false)
                document.dispatchEvent(new CustomEvent(CLOSE_ARRANGE_SHEETS))
                store.setMidiToolsOpen(!store.midiToolsOpen)
              }
              else if (action === 'snap') store.toggle('snap')
              else if (action === 'shortcuts') { setMenuOpen(false); setHelp(true) }
            }}
          />
        </AnchoredMenu>
      </header>
      {transportShown && (
        <TransportBar
          store={store}
          engine={engine}
          syncLabel={session.state.syncLabel}
          simple={phone && !land}
          phone={phone}
          recordHint={recordHint}
          onPlay={() => { engine.unlock(); void play() }}
          onStop={() => void stop()}
          onRecord={() => { engine.unlock(); void record() }}
          onSeek={(sample) => void (sample === 0 ? returnToStart() : locate(sample))}
          onReset={() => { engine.unlock(); void resetRoom() }}
          onQuickPunch={() => void quickPunch()}
          onMidi={() => { setMenuOpen(false); store.setMidiToolsOpen(true) }}
          onIdeas={toggleIdeas}
          bulbOn={unstuckOpen}
          session={session}
          roomRole={session.state.role}
          takeProgress={session.state.takeProgress}
          assetTransfers={session.state.assetTransfers}
        />
      )}
      </div>
      {phone && (
        <>
          <div id="phone-sheet-host" className="phone-sheet-host">
            <MidiTools store={store} engine={engine} phone />
          </div>
          <div className="tool-slot phone-dock-slot" id="tool-slot" data-slot="phone-dock">
            <PhoneDock
              store={store}
              place={phonePlace}
              menuOpen={menuOpen}
              browseOpen={soundsOpen}
              menuRef={menuButtonRef}
              onMenu={() => {
                setSoundsOpen(false)
                document.dispatchEvent(new CustomEvent(CLOSE_ARRANGE_SHEETS))
                setMenuOpen((open) => !open)
              }}
              onBrowse={() => {
                setMenuOpen(false)
                setSoundsOpen((open) => !open)
              }}
              onMenuAction={(action) => {
                if (action === 'new') beginNewProject()
                else if (action === 'open') { setMenuOpen(false); void openProjects() }
                else if (action === 'save') { setMenuOpen(false); void persist() }
                else if (action === 'export') { setMenuOpen(false); setExportOpen(true) }
              }}
              onUndo={() => store.undo()}
              onRedo={() => store.redo()}
              canUndo={store.canUndo}
              canRedo={store.canRedo}
              playheadSample={() => engine.currentTimelineSample()}
            />
          </div>
        </>
      )}
      {!phone && surface === 'studio' && !collabShown && phonePane !== 'room' && editorView === 'arrange' && panel !== 'piano' && (
        <div className="tool-slot" id="tool-slot" data-slot="timeline-tools">
          <ButtonTray className={`command-strip${(phone && !land) || form === 'fold' ? ' tucked' : ''}`} id="command-strip" role="toolbar" aria-label="Edit">
            <ToolBar
              context="arrange"
              words
              tucked
              store={store}
              showHint={false}
              extra={<><SnapControl store={store} inline /><div id="transport-extras" className="transport-extras-slot" /></>}
              onChange={(tool) => store.setTool(tool)}
              onDuplicate={() => store.duplicateSelection()}
              onDelete={() => store.deleteSelectedClip()}
            />
          </ButtonTray>
          <MidiTools store={store} engine={engine} />
        </div>
      )}
      <div
        className={`workspace ${dockShown ? '' : 'session-closed'} ${shellPhase !== 'off' ? 'browser-docked' : ''} ${!phone && dockEdge === 'bottom' && surface === 'studio' && dockShown ? 'dock-bottom' : ''}`}
        data-push={shellPhase}
        style={{ ['--browser' as string]: `${shellWidth}px` }}
      >
        {shellPhase !== 'off' && (
          <div className="shell-browser">
            <ShellBrowser
              store={store}
              engine={engine}
              phone={phone}
              onSeek={(sample) => void locate(sample)}
              onClose={() => { engine.stopPreview(); setSoundsOpen(false) }}
            />
          </div>
        )}
        {collabShown && (
          <div className="collab-pane" data-collab-panel="open">
            <VideoDock
              simple={false}
              session={session}
              engine={engine}
              store={store}
              versionTick={versionTick}
              onSaveVersion={() => versionSave.current('manual')}
              onCreate={() => {
                engine.unlock()
                session.primeMediaFromGesture()
                session.connect({ name: joinName || 'Engineer', create: true })
              }}
              onJoinInvite={joinCollab}
            />
          </div>
        )}
        {surface === 'studio' && !collabShown && (
          <div className="main-pane">
            <div className="editor">
              {editorView === 'arrange' && (
                <ArrangeView
                  store={store}
                  engine={engine}
                  session={session}
                  onSeek={(sample) => void locate(sample)}
                  onOpenPiano={openPiano}
                  onOpenSteps={openStepSequencer}
                  onOpenKeyboard={openKeyboard}
                  onImportInstrument={(trackId, files) => { void importAsInstrument(trackId, files) }}
                  onPerform={(mode) => openPerform(mode)}
                  onOpenBeatMachine={openBeatMachine}
                  onTrackAdded={onTrackAdded}
                  onQuickPunch={() => void quickPunch()}
                  onReset={() => { engine.unlock(); void resetRoom() }}
                  onMidi={() => { setMenuOpen(false); store.setMidiToolsOpen(true) }}
                  onAnalyze={(trackId) => { setAnalysisTrackId(trackId); setPhonePane('edit'); setSurface('studio') }}
                  libraryTab={soundsOpen ? 'library' : null}
                  browserDock={soundsOpen}
                  onBrowserDock={setSoundsOpen}
                  onLibraryClose={() => { engine.stopPreview(); setSoundsOpen(false) }}
                  phoneBar={null}
                />
              )}
              {editorView === 'mix' && <MixerView store={store} engine={engine} onTune={() => { setTuneOpen(true); setPhonePane('edit'); setSurface('studio') }} onOpenKeyboard={openKeyboard} />}
              {FEATURES.session && editorView === 'session' && (
                <Suspense fallback={null}>
                  <SessionPane
                    store={store}
                    engine={engine}
                    onRecord={() => { void record() }}
                    onDropAudio={(trackId, scene, file) => { void dropOnSlot(trackId, scene, file) }}
                    onOpenPiano={openPiano}
                    onOpenKeyboard={openKeyboard}
                  />
                </Suspense>
              )}
            </div>
          </div>
        )}
        {dockShown && <div
          className="dock-slot panel-slot"
          onPointerDown={(event) => {
            const handle = (event.target as HTMLElement).closest('.dock-resize')
            if (!handle) return
            event.preventDefault()
            const start = dockEdge === 'right' ? event.clientX : event.clientY
            const initial = dock
            const move = (ev: PointerEvent) => {
              const delta = dockEdge === 'right' ? start - ev.clientX : start - ev.clientY
              setDock(fittedDockWidth(window.innerWidth, initial + delta, dockEdge, panel === 'piano' ? 0.72 : 0.5))
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        >
          <div
            className="dock-resize"
            role="separator"
            aria-orientation={dockEdge === 'bottom' ? 'horizontal' : 'vertical'}
            aria-label="Resize editor. Drag to change its size."
            title="Drag to resize the editor."
          />
          {surface === 'studio' && panel === 'scaler' && store.scalerTrackId && (
            <ScalerPanel store={store} engine={engine} trackId={store.scalerTrackId} />
          )}
          {surface === 'studio' && panel === 'steps' && store.stepTrackId && (
            <StepSequencerPanel store={store} engine={engine} onClose={closeStepSequencer} />
          )}
          {surface === 'studio' && panel === 'pads' && store.padsTrackId && (
            <PadsPanel
              store={store}
              engine={engine}
              trackId={store.padsTrackId}
              onRecord={() => { engine.unlock(); void record() }}
              onStop={() => { void stop() }}
              onPlay={() => { engine.unlock(); void play() }}
              onEdit={(clipId) => openPiano(store.padsTrackId!, clipId)}
              onKeyboard={openBeatKeyboard}
            />
          )}
          {surface === 'studio' && panel === 'rack' && store.rackTrackId && (
            <RackView store={store} engine={engine} trackId={store.rackTrackId} onOpenKnock={() => setKnockOpen(true)} />
          )}
          {surface === 'studio' && panel === 'piano' && (
            <MidiDock store={store} engine={engine} onIdeas={() => openIdeas('progressions')} onGenerate={() => openPlugin('write')} onClose={closePiano} />
          )}
        </div>}
      </div>
      <PluginSheet store={store} engine={engine} />
      {store.patchTrackId && <PatchSheet store={store} engine={engine} trackId={store.patchTrackId} />}
      <QuantizeSheet store={store} />
      {tuneOpen && <TunerPop engine={engine} onClose={() => setTuneOpen(false)} />}
      {unstuckOpen && (
        <LazySheet label="Ideas" className="guide-sheet unstuck-sheet" onClose={() => { engine.stopPreview(); setUnstuckOpen(false) }}>
          <UnstuckSheet
            store={store}
            engine={engine}
            page={ideasPage}
            onPage={setIdeasPage}
            onClose={() => { engine.stopPreview(); setUnstuckOpen(false) }}
          />
        </LazySheet>
      )}
      {analysisTrackId && <LazySheet label="Analysis" className="analysis-sheet" onClose={() => setAnalysisTrackId(null)}><AnalysisSheet store={store} trackId={analysisTrackId} onClose={() => setAnalysisTrackId(null)} /></LazySheet>}
      {perform && (
        <PerformPop
          mode={perform}
          store={store}
          engine={engine}
          session={session}
          onRecord={() => void record()}
          onClose={() => setPerform(null)}
        />
      )}
      <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={(event) => void importAudio(event.target.files)} />
      <input ref={projectFileRef} type="file" accept=".cueharbor,.json,application/json,application/zip" hidden onChange={(event) => void importProject(event.target.files?.[0] || null)} />
      {session.state.audioLocked && session.state.status !== 'idle' && session.state.status !== 'error' && (
        <button type="button" className="text-btn primary tap-reconnect" id="tap-reconnect" onClick={() => {
          engine.unlock()
          session.primeMediaFromGesture()
          void session.resumeAudio()
        }}>
          Tap for sound
        </button>
      )}
      {projectsOpen && (
        <ProjectSheet
          dockSheet={phone}
          projects={projects}
          snapshots={snapshots}
          usage={usage}
          persisted={persisted}
          name={draftName}
          onName={setDraftName}
          onClose={() => setProjectsOpen(false)}
          onNew={() => {
            store.loadProject(createEmptyProject(engine.sampleRate), new Map())
            setProjectsOpen(false)
          }}
          onSave={() => void persist()}
          onSaveAs={() => saveAs(draftName)}
          onRename={() => {
            store.renameProject(draftName)
            void persist()
          }}
          onDuplicate={() => saveAs(`${store.project.name} copy`)}
          onDelete={(id) => {
            void deleteProject(id).then(async () => {
              const next = await listProjects()
              setProjects(next)
              if (id === store.project.id) {
                if (next[0]) {
                  const loaded = await loadProject(next[0].id)
                  if (loaded) store.loadProject(loaded.project, loaded.buffers)
                } else store.loadProject(createEmptyProject(engine.sampleRate), new Map())
              }
            })
          }}
          onOpen={(id) => {
            void loadProject(id).then((loaded) => {
              if (!loaded) return
              store.loadProject(loaded.project, loaded.buffers)
              setProjectsOpen(false)
            })
          }}
          onRevert={(key) => {
            void loadSnapshot(key).then(async (loaded) => {
              if (!loaded) return
              await saveProject(loaded.project, loaded.buffers, loaded.workspace, { snapshot: true })
              store.loadProject(loaded.project, loaded.buffers)
              setProjectsOpen(false)
            })
          }}
          onAudio={() => fileRef.current?.click()}
          onKeep={() => void requestPersistentStorage().then(() => storageReport().then((report) => setPersisted(report.persisted)))}
        />
      )}
      {exportOpen && (
        <ExportSheet
          store={store}
          phone={phone || form === 'fold'}
          dockSheet={phone}
          onClose={() => setExportOpen(false)}
          onFreeze={(audio) => {
            const source = store.selectedTrackId
            if (!source) return
            store.receiveFreeze(source, audio, engine.currentTimelineSample())
            setExportOpen(false)
          }}
        />
      )}
      {help && (
        <div className="modal-back" data-screen-overlay="" role="dialog" aria-label="Shortcuts" onClick={() => setHelp(false)}>
          <div className="modal help" onClick={(event) => event.stopPropagation()}>
            <h2>Shortcuts</h2>
            <div className="help-grid">
              {[
                ['Space', 'Play or stop'],
                ['Stop button', 'Stop'],
                ['R', 'Record'],
                ['T', 'Tap tempo'],
                ['Return or Home', 'Go to start'],
                ['← →', 'Nudge one beat'],
                ['Shift ← →', 'Nudge one bar'],
                ['L', 'Loop'],
                ['M', 'Mute the selected track'],
                ['S', 'Solo the selected track'],
                ['⌘/Ctrl Z', 'Undo'],
                ['⇧⌘/Ctrl Z, Ctrl Y, or Shift Z', 'Redo'],
                ['⌘/Ctrl S', 'Save in this browser'],
                ['⌘/Ctrl E or B', 'Split the clip at the playhead'],
                ['Delete', 'Remove the selected clip'],
                ['+ or −', 'Zoom the timeline'],
                ['1–7', 'Choose an edit tool'],
                ['?', 'Show or hide this list'],
              ].map(([key, action]) => (
                <p key={key}>
                  <kbd>{key}</kbd>
                  {action}
                </p>
              ))}
            </div>
            <button className="overlay-close" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
      {knockOpen && <LazySheet label="Knock" className="knock-pop" onClose={() => setKnockOpen(false)}><KnockPop store={store} engine={engine} onClose={() => setKnockOpen(false)} /></LazySheet>}
      {store.spectralTrackId != null && (
        <LazySheet label="Spectral repair" className="spectral-sheet" onClose={() => store.closeSpectral()}>
          <SpectralSheet store={store} />
        </LazySheet>
      )}
      {store.waveClipId && <WaveEditor store={store} engine={engine} />}
      <KeyboardDock store={store} engine={engine} onEditNotes={editNotes} />
      <HintBubble />
      <Toasts store={store} />
    </div>
    </TransportActionContext.Provider>
  )
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

