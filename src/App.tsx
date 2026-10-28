import { useEffect, useRef, useState } from 'react'
import { applyFreeze } from './audio/bounce'
import { AudioEngine } from './audio/engine'
import { unpackProject } from './model/archive'
import { renderDemoLoop } from './model/demo'
import { isSessionLink, isUntouchedEmpty, NEW_PROJECT, planLaunch, readTab, shouldKeepProject, TAB_PROJECT } from './model/launchProject'
import { channelConstraints, inputChannel, mediaChannelCount, punchWindow, sliceCapture } from './model/comp'
import { inspectClip } from './audio/stretch/engine'
import { createEmptyProject, isLocalInput, uid, type AudioClip, type TakeLane } from './model/types'
import type { IncomingTake } from './remote/session'
import { SessionClient } from './remote/session'
import { deleteProject, listProjects, listSnapshots, loadLastProject, loadProject, loadSnapshot, requestPersistentStorage, saveProject, storageReport, type ProjectListItem, type WorkspaceSnapshot } from './storage/idb'
import { inviteWins } from './model/negotiate'
import { readIdentity, writeIdentity } from './storage/identity'
import { ProjectStore, seedDemoProject } from './state/store'
import { linearResample } from './model/wav'
import { isSilentTake } from './model/media'
import { applyTransportLaunch, recordedLength } from './model/launch'
import { beatsToSamples, countInSeconds, samplesToBeats } from './model/time'
import { guestFollowStart, scheduleLeadMs } from './model/sessionSync'
import { TunerPop } from './ui/AmpPop'
import { ArrangeView } from './ui/ArrangeView'
import { BeatView } from './ui/BeatView'
import { ExportSheet } from './ui/ExportSheet'
import { formFactor, type FormFactor } from './ui/form'
import { PerformPop } from './ui/PerformPop'
import { MixerView } from './ui/MixerView'
import { PluginSheet } from './ui/PluginSheet'
import { IdeasPop } from './ui/IdeasPop'
import { UnstuckSheet } from './unstuck/UnstuckSheet'
import { LibraryPop } from './ui/LibraryPop'
import { loadScaleCatalog } from './theory'
import { AnalysisSheet } from './ui/AnalysisSheet'
import { QuantizeSheet } from './ui/QuantizeSheet'
import { MidiDock } from './ui/MidiDock'
import { KnockPop } from './ui/KnockPop'
import { ProjectSheet } from './ui/ProjectSheet'
import { PatchSheet } from './ui/PatchSheet'
import { RackView } from './ui/RackView'
import { SessionView } from './ui/SessionView'
import { TransportBar } from './ui/TransportBar'
import { ToolBar } from './ui/ToolBar'
import { VideoDock } from './ui/VideoDock'
import { MENU_COPY, UNSTUCK_COPY, VIEW_COPY, copyOf, described } from './ui/chrome'
import { HintBubble, MenuRow, TipButton } from './ui/Hint'
import { formatBytes } from './ui/share'

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

  useEffect(() => {
    const id = window.setInterval(() => {
      const hook = window as unknown as { __cueharborPlayhead?: number; __cueharborStatus?: string; __cueharborRate?: number }
      hook.__cueharborPlayhead = engine.currentTimelineSample()
      hook.__cueharborStatus = engine.status
      hook.__cueharborRate = engine.sampleRate
    }, 40)
    return () => window.clearInterval(id)
  }, [engine])
  const [version, setVersion] = useState(0)
  const [surface, setSurface] = useState<'studio' | 'artist'>('studio')
  const [dock, setDock] = useState(380)
  const [dockEdge, setDockEdge] = useState<'right' | 'bottom'>('right')
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinCode, setJoinCode] = useState('')
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
  const [form, setForm] = useState<FormFactor>(() => formFactor(window.innerWidth, window.innerHeight))
  const [land, setLand] = useState(() => window.innerWidth > window.innerHeight)
  const phone = form === 'phone'
  const [phonePane, setPhonePane] = useState<'edit' | 'room'>('edit')
  const [pianoOpen, setPianoOpen] = useState(false)
  const [tuneOpen, setTuneOpen] = useState(() => new URLSearchParams(window.location.search).get('tune') === '1')
  const [knockOpen, setKnockOpen] = useState(() => new URLSearchParams(window.location.search).get('knock') === '1')
  const [ideasOpen, setIdeasOpen] = useState(() => new URLSearchParams(window.location.search).get('ideas') === '1')
  const [unstuckOpen, setUnstuckOpen] = useState(() => new URLSearchParams(window.location.search).get('unstuck') === '1')
  const [libraryOpen, setLibraryOpen] = useState(() => new URLSearchParams(window.location.search).get('library') === '1')
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
    session.setTakeHandler((take) => placeTake(store, engine, take))
    session.setArrangementHandler((project, assets, ready) => {
      if (session.state.role === 'guest') store.remoteFollow = true
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
        if (session.state.role === 'host') return
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
        store.replaceSession(next)
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
    const identity = readIdentity()
    const choice = inviteWins(urlCode, identity?.code || '')
    if (choice.dropStored && identity) writeIdentity({ ...identity, code: '' })
    if (identity?.transportMode) store.setTransportMode(identity.transportMode)
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    if (urlCode && identity?.participantId && identity.code === urlCode) {
      if (ios && !navigator.userActivation?.isActive) session.holdMediaForGesture()
      session.connect({ name: identity.name || joinName || 'Artist', code: urlCode })
      setSurface(identity.role === 'guest' ? 'artist' : 'studio')
      setPhonePane('room')
      setJoinOpen(false)
    } else if (urlCode) {
      setJoinCode(urlCode)
      setJoinOpen(true)
      setSurface('artist')
    } else if (choice.code && identity?.participantId) {
      if (ios && !navigator.userActivation?.isActive) session.holdMediaForGesture()
      session.connect({ name: identity.name || joinName || 'Artist', code: choice.code })
      setSurface(identity.role === 'guest' ? 'artist' : 'studio')
      setPhonePane('room')
      setJoinOpen(false)
    }
    engine.sync(store.project, (id) => store.buffers.get(id))
    const unsub = store.subscribe(() => {
      engine.sync(store.project, (id) => store.buffers.get(id))
      engine.setLaunches(store.launched)
      engine.setLaunchAt(store.launchAt)
      engine.setLaunchGen(store.launchGen)
      if (session.state.status === 'live') {
        window.clearTimeout(publishTimer.current)
        publishTimer.current = window.setTimeout(() => session.publishEdits(), 40)
      }
      const key = `${store.transportMode}:${JSON.stringify(store.launched)}:${JSON.stringify(store.launchAt)}:${JSON.stringify(store.launchGen)}`
      const pending = store.takePendingTransport()
      const playing = engine.status === 'playing' || engine.status === 'recording'
      if (session.state.role !== 'guest' && pending) {
        if (!playing && store.transportMode === 'session' && Object.values(store.launched).some(Boolean)) {
          void playFrom(engine.positionSamples, 'session')
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
            mode: store.transportMode,
          })
          if (playing && store.transportMode === 'session') {
            if (engine.currentMode() !== 'session') engine.adoptSession()
            else engine.kickSession()
          } else if (playing && pending.action === 'back') engine.adoptArrangement()
        }
      }
      if (key !== launchKey.current) {
        launchKey.current = key
        if (session.state.role === 'guest') {
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
      if (store.transportMode !== 'session') return
      if (engine.status !== 'playing' && engine.status !== 'recording') return
      store.tickFollow(engine.currentTimelineSample())
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
      setIdeasOpen(true)
    }
  }, [store])

  useEffect(() => {
    const saveReady = { current: false }
    let timer = 0
    let lastQuota = 0
    let cancel = false
    const snapshot = (): WorkspaceSnapshot => ({
      view: store.view,
      transportMode: store.transportMode,
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
      if (isUntouchedEmpty(store.project)) {
        remember(NEW_PROJECT)
        return
      }
      remember(store.project.id)
      const snap = forceSnapshot || Date.now() - lastSnapshot > 20000
      if (snap) lastSnapshot = Date.now()
      void saveProject(store.project, store.buffers, snapshot(), { snapshot: snap }).then((result) => {
        if (result === 'quota' && Date.now() - lastQuota > 15000) {
          lastQuota = Date.now()
          store.toast('This browser is out of space, so the latest recording could not be kept.', 'warn')
        }
      }).catch(() => undefined)
    }
    const restoreSaved = (saved: NonNullable<Awaited<ReturnType<typeof loadLastProject>>>) => {
      store.loadProject(saved.project, saved.buffers)
      store.setView(saved.workspace.view)
      store.setTransportMode(saved.workspace.transportMode)
      if (saved.workspace.selectedTrackId) store.selectTrack(saved.workspace.selectedTrackId)
      setSurface(saved.workspace.surface)
      setPhonePane(saved.workspace.phonePane)
      engine.seek(saved.workspace.positionSamples || 0)
      engine.sync(store.project, (id) => store.buffers.get(id))
      remember(saved.project.id)
    }
    const launch = launchChoice.current ?? { plan: 'restore' as const, reload: true }
    void (async () => {
      await requestPersistentStorage()
      const saved = await loadLastProject().catch(() => null)
      if (cancel) return
      if (launch.plan === 'empty') {
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
      code,
      camOn: session.state.camOn,
      micId: session.state.micId,
      outId: session.state.outId,
      musicOn: session.state.musicOn,
      jamEnabled: session.state.jamEnabled,
      jamDelayMs: session.state.jamDelayMs,
      monitorMode: session.state.monitorMode,
      transportMode: store.transportMode,
    })
    const url = new URL(location.href)
    if (url.searchParams.get('session') !== code) {
      url.searchParams.set('session', code)
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [session, store, version])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __cue?: { measure: () => ReturnType<AudioEngine['measureLiveHit']> } }).__cue = {
      measure: () => engine.measureLiveHit(),
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
            store.toast(`Armed a track for ${person.name}. Record will print a live guide, then replace it with their aligned take.`, 'good')
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
      if (session.state.role === 'guest' && session.state.status === 'live') store.remoteFollow = true
      if (session.state.status === 'idle') store.remoteFollow = false
    })
  }, [session, store])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.shell-menu, .menu-btn')) return
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
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const key = event.key.toLowerCase()
      const meta = event.metaKey || event.ctrlKey
      if (key === 't' && !meta && !event.repeat && !store.keyboardMidi) {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('cueharbor-tap', { detail: event.timeStamp }))
      } else if (event.code === 'Space') {
        event.preventDefault()
        if (engine.status === 'stopped') void play()
        else void stop()
      } else if (key === 'r' && !meta) void record()
      else if (key === 'q' && !meta) store.quickQuantize()
      else if (meta && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
      } else if (!meta && event.shiftKey && key === 'z') store.redo()
      else if (meta && key === 's') {
        event.preventDefault()
        void persist()
      } else if ((meta && key === 'e') || key === 'b') store.splitSelected(engine.currentTimelineSample())
      else if (key === 'm' && !meta) {
        const track = store.project.tracks.find((item) => item.id === store.selectedTrackId)
        if (track && !store.remoteFollow) store.updateTrack(track.id, { mute: !track.mute })
      } else if (key === 's' && !meta) {
        const track = store.project.tracks.find((item) => item.id === store.selectedTrackId)
        if (track && !store.remoteFollow) store.updateTrack(track.id, { solo: !track.solo })
      } else if (event.key === 'Delete' || event.key === 'Backspace') store.deleteSelectedClip()
      else if (key === 'l' && !meta) store.toggle('loopEnabled')
      else if (event.key === 'Home' || event.key === 'Enter') void locate(0)
      else if (event.key === '?' || (event.shiftKey && event.key === '/')) setHelp((open) => !open)
      else if (event.key === 'Escape') {
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
    await playFrom(engine.currentTimelineSample())
  }

  async function playFrom(sample: number, mode: 'arrangement' | 'session' = 'arrangement') {
    if (session.state.role === 'guest') {
      session.requestTransport({ action: 'play', timelineSample: Math.round(sample), mode })
      return
    }
    void engine.resume()
    await ready()
    if (mode === 'arrangement') store.armArrangement()
    const lead = scheduleLeadMs(session.primaryOneWay()?.ms ?? 40)
    const counting = store.project.countIn && engine.status === 'stopped'
    const countMs = counting ? countInSeconds(store.project.tempo, store.project.timeSignature) * 1000 : 0
    engine.refreshClockAnchor()
    const hostPerf = performance.now() + lead + countMs
    session.broadcastTransport({
      action: 'play',
      timelineSample: Math.round(sample),
      hostPerfAtSample: hostPerf,
      mode,
      tempo: store.project.tempo,
      countIn: counting,
      countInMs: Math.round(countMs),
      timeSignature: store.project.timeSignature,
      launches: store.launched,
      launchAt: store.launchAt,
      launchGen: store.launchGen,
    })
    if (counting) engine.armCountIn(store.project.tempo, store.project.timeSignature)
    await engine.playAtPerf(sample, hostPerf, mode)
  }

  async function followPlay(cmd: Record<string, unknown>) {
    await ready()
    if (cmd.launches && typeof cmd.launches === 'object') {
      store.replaceSession({
        launched: cmd.launches as Record<string, string | null>,
        at: cmd.launchAt && typeof cmd.launchAt === 'object' ? (cmd.launchAt as Record<string, number>) : {},
        gen: cmd.launchGen && typeof cmd.launchGen === 'object' ? (cmd.launchGen as Record<string, number>) : {},
        mode: cmd.mode === 'session' ? 'session' : 'arrangement',
      })
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
    const mode = cmd.mode === 'session' ? 'session' : 'arrangement'
    if (counting) engine.armCountIn(tempo, signature)
    await engine.playAtPerf(Number(cmd.timelineSample) || 0, localPerf, mode)
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
    if (session.state.role === 'guest') {
      session.requestTransport({ action: 'stop' })
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
      const intoSlot = slot && slot.trackId === track.id && capture.source === 'local'
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
    store.endTake()
  }

  function openPerform(mode: 'keys' | 'drums') {
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

  async function record() {
    if (session.state.role === 'guest') {
      store.toast('The host records. Your take still lands on their timeline.', 'info')
      return
    }
    void engine.resume()
    if (engine.status === 'recording' || engine.status === 'counting-in') {
      await stop()
      return
    }
    const slot = store.sessionSlot
    const slotTrack = slot ? store.project.tracks.find((track) => track.id === slot.trackId) : undefined
    if (slot && slotTrack?.type === 'midi') {
      store.prepareMidiSlot(slot.trackId, slot.scene)
      if (engine.status !== 'playing') await playFrom(engine.currentTimelineSample(), 'session')
      return
    }
    await ready()
    const takeId = uid('take')
    const armedAudio = store.project.tracks.filter((track) => track.armed && track.type === 'audio')
    const localArmed = armedAudio.filter((track) => isLocalInput(track.input) || track.input.startsWith('mic:'))
    let mic = session.localPerformanceStream()
    if (localArmed.length && !mic) {
      const count = mediaChannelCount(localArmed.map((track) => track.input))
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: channelConstraints(count), video: false })
        engine.setLocalMic(mic)
      } catch {
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: channelConstraints(1), video: false })
          engine.setLocalMic(mic)
        } catch {
          if (!armedAudio.some((track) => track.input.startsWith('remote:'))) {
            store.toast('Microphone permission is needed to record.', 'warn')
            return
          }
        }
      }
    }
    const inputs = []
    for (const track of armedAudio) {
      const local = isLocalInput(track.input) || track.input.startsWith('mic:')
      const stream = mic || session.localPerformanceStream()
      if (local && stream) {
        const channel = inputChannel(track.input)
        inputs.push({ key: track.id, stream, source: 'local' as const, takeId, channel: channel ?? undefined })
      }
      if (track.input.startsWith('remote:')) {
        const peerId = track.input.slice('remote:'.length)
        const stream = session.remoteMusic(peerId)
        if (stream) inputs.push({ key: track.id, stream, source: 'guide' as const, peerId, takeId })
      }
    }
    if (!inputs.some((input) => input.source === 'local')) {
      const live = session.localPerformanceStream()
      const armed = store.project.tracks.find((track) => track.armed && (isLocalInput(track.input) || track.input.startsWith('mic:')))
      if (live && armed) inputs.push({ key: armed.id, stream: live, source: 'local' as const, takeId })
    }
    if (!inputs.length) {
      try {
        const stereo = store.project.tracks.some((track) => track.armed && track.type === 'audio' && track.channels === 2 && isLocalInput(track.input))
        const fresh = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: stereo ? 2 : 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false,
        })
        engine.setLocalMic(fresh)
        const armed = store.project.tracks.find((track) => track.type === 'audio' && track.armed) || store.project.tracks[0]
        inputs.push({ key: armed.id, stream: fresh, source: 'local' as const, takeId })
      } catch {
        store.toast('Arm a track with an input to record.', 'warn')
        return
      }
    }
    const settings = store.recordSettings()
    const punched = settings.punchEnabled ? punchWindow(settings, store.project.sampleRate, store.project.tempo, store.project.timeSignature) : null
    const alreadyPlaying = engine.status === 'playing'
    let fromSample = Math.round(engine.currentTimelineSample())
    if (!alreadyPlaying && punched) fromSample = punched.playFrom
    else if (!alreadyPlaying && settings.loop && store.project.loopEnabled) fromSample = store.project.loopStartSample
    const counting = store.project.countIn && !alreadyPlaying
    const lead = scheduleLeadMs(session.primaryOneWay()?.ms ?? 40)
    const countMs = counting ? countInSeconds(store.project.tempo, store.project.timeSignature) * 1000 : 0
    engine.refreshClockAnchor()
    const hostPerf = performance.now() + lead + countMs
    if (!alreadyPlaying) {
      session.broadcastTransport({
        action: 'play',
        timelineSample: fromSample,
        hostPerfAtSample: hostPerf,
        mode: 'arrangement',
        tempo: store.project.tempo,
        countIn: counting,
        countInMs: Math.round(countMs),
        timeSignature: store.project.timeSignature,
      })
    }
    await engine.beginRecord({
      fromSample,
      inputs,
      countIn: counting,
      hostPerfAtSample: alreadyPlaying ? undefined : hostPerf,
      onPunch: (info) => {
        takeRef.current = { id: takeId, endSample: info.timelineSample }
        store.beginTake()
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
      view: store.view,
      transportMode: store.transportMode,
      positionSamples: Math.round(engine.positionSamples),
      selectedTrackId: store.selectedTrackId,
      surface,
      phonePane,
    }
  }

  async function persist() {
    const result = await saveProject(store.project, store.buffers, workspaceNow(), { snapshot: true })
    store.toast(result === 'quota' ? 'This browser is out of space, so the project could not be kept.' : 'Saved in this browser.', result === 'quota' ? 'warn' : 'good')
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

  function joinSession() {
    engine.unlock()
    session.primeMediaFromGesture()
    session.connect({ name: joinName || 'Artist', code: joinCode.trim() })
    setJoinOpen(false)
    setSurface('artist')
    setPhonePane('room')
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

  async function importAudio(files: FileList | null) {
    if (!files?.length) return
    await ready()
    const track = store.project.tracks.find((item) => item.id === store.selectedTrackId && item.type === 'audio') || store.project.tracks.find((item) => item.type === 'audio')
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

  const armedTrack = store.sessionSlot ? store.project.tracks.find((track) => track.id === store.sessionSlot?.trackId) : undefined
  const rollWanted = !!store.selectedMidiClipId && (store.view === 'arrange' || store.view === 'beats' || (store.view === 'session' && armedTrack?.type === 'midi'))
  const panel: 'room' | 'piano' | 'rack' =
    surface !== 'studio' || phonePane === 'room' ? 'room'
    : pianoOpen ? 'piano'
    : store.rackTrackId ? 'rack'
    : rollWanted ? 'piano'
    : 'room'
  const pianoTrack = store.project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
    || store.project.tracks.find((track) => track.type === 'midi')

  function openPiano(trackId: string, clipId?: string) {
    const beat = samplesToBeats(engine.positionSamples, store.project.sampleRate, store.project.tempo)
    store.preparePianoClip(trackId, beat, clipId)
    setSurface('studio')
    setPhonePane('edit')
    store.setView('arrange')
    setPianoOpen(true)
  }

  return (
    <div
      className={`shell ${surface} ${phone ? 'phone' : ''} ${form === 'fold' ? 'fold' : ''} ${land ? 'land' : ''} ${phonePane === 'room' && surface === 'studio' ? 'room' : ''}`}
      style={{ ['--dock' as string]: `${dock}px` }}
      data-version={version}
      data-form={form}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer.files.length) void importDropped(event.dataTransfer.files)
      }}
    >
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 18 18">
              <path d="M2 12c2-4 3.4-6 7-6s5 2 7 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="9" cy="5.5" r="1.3" fill="currentColor" />
            </svg>
          </div>
          <h1>CueHarbor</h1>
        </div>
        <input className="project-name" aria-label="Project name" value={store.project.name} onChange={(event) => store.renameProject(event.target.value)} />
        <div className="views">
          {(['arrange', 'mix', 'beats'] as const).map((view) => {
            const copy = copyOf(VIEW_COPY, view)
            return (
              <button
                key={view}
                type="button"
                className={surface === 'studio' && phonePane !== 'room' && store.view === view ? 'active' : ''}
                {...described(copy)}
                onClick={() => { setPhonePane('edit'); setSurface('studio'); store.setView(view); setMenuOpen(false) }}
              >
                {copy.label}
              </button>
            )
          })}
          <button
            type="button"
            className={surface === 'studio' && phonePane === 'room' ? 'active' : ''}
            {...described(copyOf(VIEW_COPY, 'session'))}
            onClick={() => { setPianoOpen(false); setPhonePane('room'); setSurface('studio'); setMenuOpen(false) }}
          >
            Session
          </button>
        </div>
        <TipButton
          className={`unstuck-btn ${unstuckOpen ? 'on' : ''}`}
          label={UNSTUCK_COPY.label}
          hint={UNSTUCK_COPY.hint}
          pressed={unstuckOpen}
          disabled={store.remoteFollow}
          onClick={() => { setMenuOpen(false); setUnstuckOpen((open) => !open) }}
        />
        <button type="button" className={`menu-btn ${menuOpen ? 'on' : ''}`} aria-label="Menu. Save, export, clips, and setup." title="Save, export, clips, and setup." aria-expanded={menuOpen} aria-controls="shell-menu" onClick={() => setMenuOpen((open) => !open)}>
          <MenuIcon />
        </button>
        {menuOpen && (
          <div className="shell-menu" id="shell-menu">
            <MenuRow id="menu-save" label={copyOf(MENU_COPY, 'save').label} hint={copyOf(MENU_COPY, 'save').hint} onClick={() => { setMenuOpen(false); void openProjects() }} />
            <MenuRow label={copyOf(MENU_COPY, 'export').label} hint={copyOf(MENU_COPY, 'export').hint} onClick={() => { setMenuOpen(false); setExportOpen(true) }} />
            <MenuRow className="split" label={copyOf(MENU_COPY, 'clips').label} hint={copyOf(MENU_COPY, 'clips').hint} onClick={() => { setMenuOpen(false); setPhonePane('edit'); setSurface('studio'); store.setView('session') }} />
            <MenuRow label={copyOf(MENU_COPY, 'keys').label} hint={copyOf(MENU_COPY, 'keys').hint} onClick={() => { setMenuOpen(false); openPerform('keys') }} />
            <MenuRow label={copyOf(MENU_COPY, 'pads').label} hint={copyOf(MENU_COPY, 'pads').hint} onClick={() => { setMenuOpen(false); openPerform('drums') }} />
            <MenuRow label={copyOf(MENU_COPY, 'piano').label} hint={copyOf(MENU_COPY, 'piano').hint} disabled={!pianoTrack} onClick={() => { if (!pianoTrack) return; setMenuOpen(false); openPiano(pianoTrack.id) }} />
            <MenuRow label="Scales" hint="Browse scales and the chords inside them." onClick={() => { setMenuOpen(false); setLibraryOpen(true) }} />
            <MenuRow className="split" label={copyOf(MENU_COPY, 'quantize').label} hint={copyOf(MENU_COPY, 'quantize').hint} onClick={() => { setMenuOpen(false); store.quickQuantize() }} />
            <MenuRow label={copyOf(MENU_COPY, 'quantize-more').label} hint={copyOf(MENU_COPY, 'quantize-more').hint} onClick={() => { setMenuOpen(false); store.openQuantize() }} />
            <MenuRow className="split" label={copyOf(MENU_COPY, 'click').label} hint={copyOf(MENU_COPY, 'click').hint} pressed={store.project.metronomeEnabled} disabled={store.remoteFollow} onClick={() => store.toggle('metronomeEnabled')} />
            <MenuRow label={copyOf(MENU_COPY, 'count-in').label} hint={copyOf(MENU_COPY, 'count-in').hint} pressed={store.project.countIn} disabled={store.remoteFollow} onClick={() => store.toggle('countIn')} />
            <MenuRow label={copyOf(MENU_COPY, 'snap').label} hint={copyOf(MENU_COPY, 'snap').hint} pressed={store.project.snap} disabled={store.remoteFollow} onClick={() => store.toggle('snap')} />
            {phone && (
              <>
                <MenuRow label={copyOf(MENU_COPY, 'to-start').label} hint={copyOf(MENU_COPY, 'to-start').hint} onClick={() => { setMenuOpen(false); void locate(0) }} />
                <MenuRow label={copyOf(MENU_COPY, 'loop').label} hint={copyOf(MENU_COPY, 'loop').hint} pressed={store.project.loopEnabled} disabled={store.remoteFollow} onClick={() => store.toggle('loopEnabled')} />
              </>
            )}
            <label className="menu-sig">
              Sig
              <select
                aria-label="Time signature. Beats in each bar."
                title="Beats in each bar."
                value={`${store.project.timeSignature.numerator}/${store.project.timeSignature.denominator}`}
                disabled={store.remoteFollow}
                onChange={(event) => {
                  const [n, d] = event.target.value.split('/').map(Number)
                  store.setTimeSignature(n, d)
                }}
              >
                {['4/4', '3/4', '6/8', '5/4', '7/8'].map((sig) => <option key={sig}>{sig}</option>)}
              </select>
            </label>
            <MenuRow
              className="split"
              label={store.transportMode === 'session' ? copyOf(MENU_COPY, 'arrangement').label : copyOf(MENU_COPY, 'session-view').label}
              hint={store.transportMode === 'session' ? copyOf(MENU_COPY, 'arrangement').hint : copyOf(MENU_COPY, 'session-view').hint}
              disabled={store.remoteFollow}
              onClick={() => {
                setMenuOpen(false)
                setPhonePane('edit')
                setSurface('studio')
                if (store.transportMode === 'session') store.backToArrangement()
                else store.enterSession()
              }}
            />
            <MenuRow label={copyOf(MENU_COPY, 'capture').label} hint={copyOf(MENU_COPY, 'capture').hint} disabled={store.remoteFollow} onClick={() => { setMenuOpen(false); store.captureToArrangement() }} />
            <MenuRow
              className="split"
              label={surface === 'studio' ? copyOf(MENU_COPY, 'artist').label : copyOf(MENU_COPY, 'studio').label}
              hint={surface === 'studio' ? copyOf(MENU_COPY, 'artist').hint : copyOf(MENU_COPY, 'studio').hint}
              onClick={() => {
                setMenuOpen(false)
                if (surface === 'studio') {
                  setSurface('artist')
                  setPhonePane('room')
                } else setSurface('studio')
              }}
            />
            {!phone && (
              <MenuRow
                label={dockEdge === 'right' ? copyOf(MENU_COPY, 'dock-bottom').label : copyOf(MENU_COPY, 'dock-side').label}
                hint={dockEdge === 'right' ? copyOf(MENU_COPY, 'dock-bottom').hint : copyOf(MENU_COPY, 'dock-side').hint}
                onClick={() => setDockEdge(dockEdge === 'right' ? 'bottom' : 'right')}
              />
            )}
            <MenuRow label={copyOf(MENU_COPY, 'shortcuts').label} hint={copyOf(MENU_COPY, 'shortcuts').hint} onClick={() => { setMenuOpen(false); setHelp(true) }} />
          </div>
        )}
      </header>
      {(surface === 'studio' || session.state.status === 'live') && (
        <TransportBar
          store={store}
          engine={engine}
          syncLabel={session.state.syncLabel}
          simple={phone}
          onPlay={() => void play()}
          onStop={() => void stop()}
          onRecord={() => void record()}
          onSeek={(sample) => void locate(sample)}
        />
      )}
      {surface === 'studio' && phonePane !== 'room' && store.view !== 'mix' && (store.view === 'arrange' || panel === 'piano') && (
        <div className="tool-slot" id="tool-slot" data-slot="timeline-tools">
          <ToolBar
            context={panel === 'piano' ? 'piano' : 'arrange'}
            compact={form !== 'desk'}
            onChange={(tool) => store.setTool(tool)}
            onDuplicate={() => store.duplicateSelection()}
            onDelete={() => store.deleteSelectedClip()}
          />
        </div>
      )}
      <div className={`workspace ${!phone && dockEdge === 'bottom' && surface === 'studio' ? 'dock-bottom' : ''}`}>
        {surface === 'studio' && (
          <div className="main-pane">
            <div className="editor">
              {store.view === 'arrange' && (
                <ArrangeView
                  store={store}
                  engine={engine}
                  session={session}
                  onSeek={(sample) => void locate(sample)}
                  onOpenPiano={openPiano}
                  onPerform={(mode) => openPerform(mode)}
                  onQuickPunch={() => void quickPunch()}
                  onAnalyze={(trackId) => { setAnalysisTrackId(trackId); setPhonePane('edit'); setSurface('studio') }}
                />
              )}
              {store.view === 'mix' && <MixerView store={store} engine={engine} onTune={() => { setTuneOpen(true); setPhonePane('edit'); setSurface('studio') }} />}
              {store.view === 'beats' && <BeatView store={store} engine={engine} />}
              {store.view === 'session' && <SessionView store={store} engine={engine} />}
            </div>
          </div>
        )}
        <div
          className="dock-slot panel-slot"
          onPointerDown={(event) => {
            const handle = (event.target as HTMLElement).closest('.dock-resize')
            if (!handle) return
            event.preventDefault()
            const start = dockEdge === 'right' ? event.clientX : event.clientY
            const initial = dock
            const move = (ev: PointerEvent) => {
              const delta = dockEdge === 'right' ? start - ev.clientX : start - ev.clientY
              setDock(Math.min(dockEdge === 'right' ? 760 : 520, Math.max(280, initial + delta)))
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        >
          {surface === 'studio' && panel === 'rack' && store.rackTrackId && (
            <RackView store={store} engine={engine} trackId={store.rackTrackId} onOpenKnock={() => setKnockOpen(true)} />
          )}
          {surface === 'studio' && panel === 'piano' && (
            <MidiDock store={store} engine={engine} onIdeas={() => setIdeasOpen(true)} onLibrary={() => setLibraryOpen(true)} />
          )}
          {(surface !== 'studio' || panel === 'room') && (
            <VideoDock
              simple={surface === 'artist'}
              session={session}
              engine={engine}
              onCreate={() => {
                engine.unlock()
                session.primeMediaFromGesture()
                setSurface('studio')
                setPhonePane('room')
                session.connect({ name: joinName || 'Engineer', create: true })
              }}
              onNewSession={() => {
                engine.unlock()
                session.primeMediaFromGesture()
                setSurface('studio')
                setPhonePane('room')
                setMenuOpen(false)
                session.connect({ name: joinName || 'Engineer', create: true, fresh: true })
              }}
              onJoin={() => setJoinOpen(true)}
            />
          )}
        </div>
      </div>
      <PluginSheet store={store} engine={engine} />
      {store.patchTrackId && <PatchSheet store={store} engine={engine} trackId={store.patchTrackId} />}
      <QuantizeSheet store={store} />
      {tuneOpen && <TunerPop engine={engine} onClose={() => setTuneOpen(false)} />}
      {ideasOpen && <IdeasPop store={store} engine={engine} onClose={() => setIdeasOpen(false)} />}
      {unstuckOpen && <UnstuckSheet store={store} engine={engine} onClose={() => { engine.stopPreview(); setUnstuckOpen(false) }} />}
      {libraryOpen && <LibraryPop store={store} engine={engine} onClose={() => setLibraryOpen(false)} />}
      {analysisTrackId && <AnalysisSheet store={store} trackId={analysisTrackId} onClose={() => setAnalysisTrackId(null)} />}
      {perform && (
        <PerformPop
          mode={perform}
          store={store}
          engine={engine}
          session={session}
          onRecord={() => void record()}
          onClose={() => setPerform(null)}
          onLibrary={() => setLibraryOpen(true)}
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
      {joinOpen && (
        <div className="modal-back">
          <div className="modal">
            <h2>Join</h2>
            <div className="stack">
              <input value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="Your name" />
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Invite code" />
              <div className="row-btns">
                <button type="button" className="text-btn" onClick={() => setJoinOpen(false)}>Cancel</button>
                <button type="button" className="text-btn primary" id="join-session" onClick={joinSession}>
                  Join
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {projectsOpen && (
        <ProjectSheet
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
          onClose={() => setExportOpen(false)}
          onFreeze={(audio, start) => {
            const source = store.selectedTrackId
            if (!source) return
            const next = applyFreeze(store.project, store.buffers, source, audio, start)
            store.replace(next.project, next.buffers)
            const created = next.project.tracks.find((track) => track.name.endsWith(' bounce'))
            if (created) store.selectTrack(created.id)
            setExportOpen(false)
          }}
        />
      )}
      {help && (
        <div className="modal-back" onClick={() => setHelp(false)}>
          <div className="modal help" onClick={(event) => event.stopPropagation()}>
            <h2>Shortcuts</h2>
            <div className="help-grid">
              {[
                ['Space', 'Play or stop'],
                ['Stop button', 'Stop'],
                ['R', 'Record'],
                ['Return or Home', 'Go to start'],
                ['← →', 'Nudge one beat'],
                ['Shift ← →', 'Nudge one bar'],
                ['L', 'Loop'],
                ['M', 'Mute the selected track'],
                ['S', 'Solo the selected track'],
                ['⌘/Ctrl Z', 'Undo'],
                ['⇧⌘/Ctrl Z or Shift Z', 'Redo'],
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
            <button className="text-btn" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
      {knockOpen && <KnockPop store={store} engine={engine} onClose={() => setKnockOpen(false)} />}
      <HintBubble />
      <div className="toasts">
        {store.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone || ''}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function placeTake(store: ProjectStore, engine: AudioEngine, take: IncomingTake) {
  const channels = take.channels.map((channel) =>
    take.sampleRate === engine.sampleRate ? channel : linearResample(channel, take.sampleRate, engine.sampleRate),
  )
  store.removeClips((clip) => clip.source === 'guide' && clip.takeId === take.takeId)
  store.dropGuideLanes(take.takeId)
  let track = store.project.tracks.find((item) => item.input === `remote:${take.peerId}`)
  if (!track) {
    store.ensureRemoteTrack(take.peerId, take.peerName)
    track = store.project.tracks.find((item) => item.input === `remote:${take.peerId}`)
  }
  if (!track) return
  const bufferId = uid('buf')
  store.addAsset({ id: bufferId, name: `${take.peerName} take`, sampleRate: engine.sampleRate, channels })
  store.addTakeLane(track.id, {
    id: uid('lane'),
    name: `${take.peerName} aligned`,
    bufferId,
    offsetSamples: 0,
    startSample: Math.max(0, take.placeAtSample),
    durationSamples: channels[0].length,
    peerId: take.peerId,
    takeId: take.takeId,
    source: 'aligned-take',
  })
  store.toast(
    take.silent
      ? `${take.peerName} take arrived, but it is silent. Check their performance mic.`
      : `${take.peerName} aligned −${take.compensationMs.toFixed(0)} ms. ${take.detail}`,
    take.silent ? 'warn' : 'good',
  )
}
