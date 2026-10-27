import { useEffect, useRef, useState } from 'react'
import { AudioEngine } from './audio/engine'
import { renderDemoLoop } from './model/demo'
import { uid, type AudioClip } from './model/types'
import type { IncomingTake } from './remote/session'
import { SessionClient } from './remote/session'
import { listProjects, loadLastProject, loadProject, requestPersistentStorage, saveProject, base64ToBytes, bytesToBase64, type WorkspaceSnapshot } from './storage/idb'
import { inviteWins } from './model/negotiate'
import { readIdentity, writeIdentity } from './storage/identity'
import { ProjectStore, seedDemoProject } from './state/store'
import { decodeWavPCM, encodeWav, linearResample } from './model/wav'
import { isSilentTake } from './model/media'
import { beatsToSamples, countInSeconds, samplesToBeats } from './model/time'
import { guestFollowStart, scheduleLeadMs } from './model/sessionSync'
import { ArrangeView } from './ui/ArrangeView'
import { MixerView } from './ui/MixerView'
import { PluginSheet } from './ui/PluginSheet'
import { PianoRoll } from './ui/PianoRoll'
import { SessionView } from './ui/SessionView'
import { TransportBar } from './ui/TransportBar'
import { VideoDock } from './ui/VideoDock'
import { downloadBlob } from './ui/format'
import { formFactor, type FormFactor } from './ui/form'

interface Bundle {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
}

function createBundle(): Bundle {
  const engine = new AudioEngine()
  const seeded = seedDemoProject(48000, renderDemoLoop(48000, 4, 120))
  const store = new ProjectStore(seeded.project, seeded.buffers)
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
  const [saved, setSaved] = useState<{ id: string; name: string; savedAt: number }[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [form, setForm] = useState<FormFactor>(() => formFactor(window.innerWidth, window.innerHeight))
  const [land, setLand] = useState(() => window.innerWidth > window.innerHeight)
  const phone = form === 'phone'
  const compact = form !== 'desk'
  const [phonePane, setPhonePane] = useState<'edit' | 'room'>('edit')
  const [pianoOpen, setPianoOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const projectFileRef = useRef<HTMLInputElement>(null)
  const takeRef = useRef<{ id: string; endSample: number } | null>(null)
  const armedPeers = useRef(new Set<string>())
  const launchKey = useRef('')
  const publishTimer = useRef(0)
  const pendingFollow = useRef<Record<string, unknown> | null>(null)
  const workletWarned = useRef(false)
  const surfaceRef = useRef(surface)
  const phonePaneRef = useRef(phonePane)
  const flushSave = useRef<() => void>(() => {})
  surfaceRef.current = surface
  phonePaneRef.current = phonePane

  useEffect(() => {
    session.bindArrangement(store)
    session.setTakeHandler((take) => placeTake(store, engine, take))
    session.setArrangementHandler((project, assets, ready) => {
      store.remoteFollow = true
      store.loadProject(project, assets)
      engine.sync(project, (id) => assets.get(id) || store.buffers.get(id))
      if (ready && pendingFollow.current && engine.status === 'stopped') void followPlay(pendingFollow.current)
    })
    session.setControlHandler((cmd) => {
      const action = String(cmd.action || '')
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
    return store.subscribe(() => {
      engine.sync(store.project, (id) => store.buffers.get(id))
      engine.setLaunches(store.launched)
      if (session.state.role === 'host') {
        window.clearTimeout(publishTimer.current)
        publishTimer.current = window.setTimeout(() => session.publishArrangement(), 40)
      }
      const key = `${store.transportMode}:${JSON.stringify(store.launched)}`
      if (store.transportMode === 'session' && key !== launchKey.current) {
        launchKey.current = key
        void playFrom(engine.positionSamples, 'session')
      } else launchKey.current = key
      setVersion((value) => value + 1)
    })
  }, [store, engine, session])

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
    const write = () => {
      if (!saveReady.current || cancel) return
      void saveProject(store.project, store.buffers, snapshot()).then((result) => {
        if (result === 'quota' && Date.now() - lastQuota > 15000) {
          lastQuota = Date.now()
          store.toast('This browser is out of space, so the latest recording could not be kept.', 'warn')
        }
      }).catch(() => undefined)
    }
    void (async () => {
      await requestPersistentStorage()
      const saved = await loadLastProject().catch(() => null)
      if (cancel) return
      if (saved) {
        store.loadProject(saved.project, saved.buffers)
        store.setView(saved.workspace.view)
        store.setTransportMode(saved.workspace.transportMode)
        if (saved.workspace.selectedTrackId) store.selectTrack(saved.workspace.selectedTrackId)
        setSurface(saved.workspace.surface)
        setPhonePane(saved.workspace.phonePane)
        engine.seek(saved.workspace.positionSamples || 0)
        engine.sync(store.project, (id) => store.buffers.get(id))
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
      write()
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
      if (event.code === 'Space') {
        event.preventDefault()
        if (engine.status === 'stopped') void play()
        else void stop()
      } else if (key === 'r' && !meta) void record()
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
      else if (event.key === 'Escape') setHelp(false)
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
    })
    if (counting) engine.armCountIn(store.project.tempo, store.project.timeSignature)
    await engine.playAtPerf(sample, hostPerf, mode)
  }

  async function followPlay(cmd: Record<string, unknown>) {
    await ready()
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
    for (const capture of captures) {
      const bufferId = uid('buf')
      const track = store.project.tracks.find((item) => item.armed && (capture.peerId ? item.input === `remote:${capture.peerId}` : item.input === 'mic'))
      store.addAsset({
        id: bufferId,
        name: capture.source === 'guide' ? 'Live guide' : 'Recording',
        sampleRate: capture.sampleRate,
        channels: capture.channels,
      })
      if (!track) continue
      const clip: AudioClip = {
        id: uid('clip'),
        name: capture.source === 'guide' ? `${track.name} guide` : track.name,
        bufferId,
        startSample: capture.startSample,
        offsetSamples: 0,
        durationSamples: capture.channels[0].length,
        fadeInSamples: 64,
        fadeOutSamples: 128,
        gain: 1,
        source: capture.source === 'guide' ? 'guide' : 'local',
        peerId: capture.peerId,
        takeId: capture.takeId,
      }
      store.addAudioClip(track.id, clip)
      if (capture.source === 'guide' && isSilentTake(capture.channels)) {
        store.toast(`${track.name} guide is silent. Video and the live mic need a connected media path. The aligned take replaces this if the upload arrives.`, 'warn')
      }
    }
    if (takeRef.current) {
      session.broadcastTransport({ action: 'record-stop', takeId: takeRef.current.id, timelineSample: end })
      takeRef.current = null
    }
    session.broadcastTransport({ action: 'stop', timelineSample: end })
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
    await ready()
    const takeId = uid('take')
    const inputs = []
    for (const track of store.project.tracks) {
      if (!track.armed || track.type !== 'audio') continue
      if (track.input === 'mic' && session.localPerformanceStream()) {
        inputs.push({ key: track.id, stream: session.localPerformanceStream()!, source: 'local' as const, takeId })
      }
      if (track.input.startsWith('remote:')) {
        const peerId = track.input.slice('remote:'.length)
        const stream = session.remoteMusic(peerId)
        if (stream) inputs.push({ key: track.id, stream, source: 'guide' as const, peerId, takeId })
      }
    }
    if (!inputs.some((input) => input.source === 'local')) {
      const mic = session.localPerformanceStream()
      const armed = store.project.tracks.find((track) => track.armed && track.input === 'mic')
      if (mic && armed) inputs.push({ key: armed.id, stream: mic, source: 'local' as const, takeId })
    }
    if (!inputs.length) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false,
        })
        engine.setLocalMic(mic)
        const armed = store.project.tracks.find((track) => track.type === 'audio' && track.armed) || store.project.tracks[0]
        inputs.push({ key: armed.id, stream: mic, source: 'local' as const, takeId })
      } catch {
        store.toast('Microphone permission is needed to record.', 'warn')
        return
      }
    }
    const fromSample = Math.round(engine.currentTimelineSample())
    const alreadyPlaying = engine.status === 'playing'
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

  async function bounce() {
    await ready()
    const wav = await engine.exportMix(store.project, store.buffers)
    downloadBlob(`${store.project.name.replace(/\s+/g, '-').toLowerCase()}.wav`, new Blob([wav], { type: 'audio/wav' }))
    store.toast('Mix bounced to WAV.', 'good')
  }

  async function persist() {
    const result = await saveProject(store.project, store.buffers, {
      view: store.view,
      transportMode: store.transportMode,
      positionSamples: Math.round(engine.positionSamples),
      selectedTrackId: store.selectedTrackId,
      surface,
      phonePane,
    })
    store.toast(result === 'quota' ? 'This browser is out of space, so the project could not be kept.' : 'Saved in this browser.', result === 'quota' ? 'warn' : 'good')
  }

  function joinSession() {
    engine.unlock()
    session.primeMediaFromGesture()
    session.connect({ name: joinName || 'Artist', code: joinCode.trim() })
    setJoinOpen(false)
    setSurface('artist')
    setPhonePane('room')
  }

  async function openLibrary() {
    setSaved(await listProjects())
    setLibraryOpen(true)
  }

  function exportFile() {
    const assets = [...store.buffers.values()].map((asset) => ({
      id: asset.id,
      name: asset.name,
      sampleRate: asset.sampleRate,
      wav: bytesToBase64(new Uint8Array(encodeWav(asset.channels, asset.sampleRate))),
    }))
    const blob = new Blob([JSON.stringify({ project: store.project, assets })], { type: 'application/json' })
    downloadBlob(`${store.project.name.replace(/\s+/g, '-').toLowerCase()}.cueharbor.json`, blob)
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
      })
    }
  }

  async function importProject(file: File | null) {
    if (!file) return
    const parsed = JSON.parse(await file.text()) as {
      project: Bundle['store']['project']
      assets: { id: string; name: string; sampleRate: number; wav: string }[]
    }
    const buffers = new Map()
    for (const asset of parsed.assets) {
      const decoded = decodeWavPCM(base64ToBytes(asset.wav).buffer as ArrayBuffer)
      buffers.set(asset.id, { id: asset.id, name: asset.name, sampleRate: decoded.sampleRate, channels: decoded.channels })
    }
    store.loadProject(parsed.project, buffers)
    await ready()
  }

  const showRoll = store.view === 'arrange' && store.selectedMidiClipId && !pianoOpen

  function openPiano(trackId: string, clipId?: string) {
    const beat = samplesToBeats(engine.positionSamples, store.project.sampleRate, store.project.tempo)
    store.preparePianoClip(trackId, beat, clipId)
    setSurface('studio')
    setPhonePane('edit')
    store.setView('arrange')
    setPianoOpen(true)
  }

  return (
    <div className={`shell ${surface} ${phone ? 'phone' : ''} ${form === 'fold' ? 'fold' : ''} ${land ? 'land' : ''}`} style={{ ['--dock' as string]: `${dock}px` }} data-version={version} data-form={form}>
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path d="M2 12c2-4 3.4-6 7-6s5 2 7 6" fill="none" stroke="#73c48f" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="9" cy="5.5" r="1.3" fill="#e0b15a" />
            </svg>
          </div>
          <div>
            <h1>CueHarbor</h1>
          </div>
        </div>
        <input className="project-name" value={store.project.name} onChange={(event) => store.renameProject(event.target.value)} />
        {!phone && (
          <div className="views">
            {(['arrange', 'mix', 'session'] as const).map((view) => (
              <button key={view} className={store.view === view ? 'active' : ''} onClick={() => { setSurface('studio'); store.setView(view) }}>
                {view}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {compact ? (
          <button className="text-btn menu-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            {menuOpen ? 'Close' : 'Menu'}
          </button>
        ) : (
          <div className="top-actions">
            <button className="text-btn" onClick={() => void persist()}>Save</button>
            <button className="text-btn" onClick={() => void openLibrary()}>Library</button>
            <button className="text-btn" onClick={exportFile}>File</button>
            <button className="text-btn" onClick={() => projectFileRef.current?.click()}>Open</button>
            <button className="text-btn" onClick={() => fileRef.current?.click()}>Import</button>
            <button className="text-btn" onClick={() => void bounce()}>Bounce</button>
            <button className="text-btn" onClick={() => store.addTrack('audio')}>+ Audio</button>
            <button className="text-btn" onClick={() => store.addTrack('midi')}>+ Inst</button>
            <button className="text-btn" onClick={() => store.addTrack('bus')}>+ Bus</button>
            <button className="text-btn" onClick={() => store.addTrack('group')}>+ Group</button>
            <button className="text-btn" onClick={() => setHelp(true)} title="Shortcuts" aria-label="Shortcuts">?</button>
            <button className="text-btn" aria-label={surface === 'studio' ? 'Artist view' : 'Studio'} onClick={() => setSurface(surface === 'studio' ? 'artist' : 'studio')}>
              {surface === 'studio' ? 'Artist' : 'Studio'}
            </button>
            <button className="text-btn" aria-label={dockEdge === 'right' ? 'Dock bottom' : 'Dock right'} onClick={() => setDockEdge(dockEdge === 'right' ? 'bottom' : 'right')}>
              {dockEdge === 'right' ? 'Bottom' : 'Side'}
            </button>
          </div>
        )}
        {compact && menuOpen && (
          <div className="phone-menu">
            <button className="text-btn" onClick={() => { setMenuOpen(false); void persist() }}>Save</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); void openLibrary() }}>Library</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); exportFile() }}>File</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); projectFileRef.current?.click() }}>Open</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); fileRef.current?.click() }}>Import</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); void bounce() }}>Bounce</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); store.addTrack('audio') }}>+ Audio</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); store.addTrack('midi') }}>+ Inst</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); store.addTrack('bus') }}>+ Bus</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); store.addTrack('group') }}>+ Group</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); setPhonePane('edit'); setSurface('studio'); store.setView('session') }}>Clips</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); setHelp(true) }}>Shortcuts</button>
            <button className="text-btn" onClick={() => { setMenuOpen(false); setSurface(surface === 'studio' ? 'artist' : 'studio'); setPhonePane('room') }}>
              {surface === 'studio' ? 'Artist' : 'Studio'}
            </button>
          </div>
        )}
      </header>
      {(surface === 'studio' || session.state.status === 'live') && (
        <TransportBar
          store={store}
          engine={engine}
          syncLabel={session.state.syncLabel}
          onPlay={() => void play()}
          onStop={() => void stop()}
          onRecord={() => void record()}
          onSeek={(sample) => void locate(sample)}
          onPiano={(trackId) => openPiano(trackId)}
        />
      )}
      <div className={`workspace ${!phone && dockEdge === 'bottom' && surface === 'studio' ? 'dock-bottom' : ''}`}>
        {surface === 'studio' && (!phone || phonePane === 'edit') && (
          <div className="main-pane">
            <div className="editor">
              {store.view === 'arrange' && <ArrangeView store={store} engine={engine} session={session} onSeek={(sample) => void locate(sample)} onOpenPiano={openPiano} />}
              {store.view === 'mix' && <MixerView store={store} engine={engine} />}
              {store.view === 'session' && <SessionView store={store} />}
            </div>
            {showRoll && form !== 'fold' && <PianoRoll store={store} engine={engine} />}
          </div>
        )}
        {form === 'fold' && showRoll && surface === 'studio' && (
          <div className="side-editor">
            <PianoRoll store={store} engine={engine} />
          </div>
        )}
        {(!phone || phonePane === 'room' || surface === 'artist') && !(form === 'fold' && showRoll) && (
        <div
          className="dock-slot"
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
        </div>
        )}
      </div>
      <PluginSheet store={store} engine={engine} />
      {pianoOpen && (
        <div className="piano-pop" data-piano="open" role="dialog" aria-label="Piano">
          <header>
            <strong>Piano</strong>
            <button type="button" aria-label="Close piano" onClick={() => setPianoOpen(false)}>×</button>
          </header>
          <PianoRoll store={store} engine={engine} />
        </div>
      )}
      {phone && (
        <nav className="phone-tabs" aria-label="Sections">
          <button className={phonePane === 'edit' && store.view === 'arrange' ? 'active' : ''} onClick={() => { setPhonePane('edit'); setSurface('studio'); store.setView('arrange'); setMenuOpen(false) }}>Arrange</button>
          <button className={phonePane === 'edit' && store.view === 'mix' ? 'active' : ''} onClick={() => { setPhonePane('edit'); setSurface('studio'); store.setView('mix'); setMenuOpen(false) }}>Mix</button>
          <button className={phonePane === 'room' ? 'active' : ''} onClick={() => { setPhonePane('room'); setSurface('studio'); setMenuOpen(false) }}>Session</button>
        </nav>
      )}
      <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={(event) => void importAudio(event.target.files)} />
      <input ref={projectFileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importProject(event.target.files?.[0] || null)} />
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
      {libraryOpen && (
        <div className="modal-back">
          <div className="modal">
            <h2>Browser library</h2>
            <div className="stack">
              {saved.length === 0 && <p>Nothing saved yet.</p>}
              {saved.map((item) => (
                <button
                  key={item.id}
                  className="text-btn"
                  onClick={() => {
                    void loadProject(item.id).then((loaded) => {
                      if (!loaded) return
                      store.loadProject(loaded.project, loaded.buffers)
                      setLibraryOpen(false)
                    })
                  }}
                >
                  {item.name}
                </button>
              ))}
              <div className="row-btns">
                <button className="text-btn" onClick={() => setLibraryOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
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

function placeTake(store: ProjectStore, engine: AudioEngine, take: IncomingTake) {
  const channels = take.channels.map((channel) =>
    take.sampleRate === engine.sampleRate ? channel : linearResample(channel, take.sampleRate, engine.sampleRate),
  )
  store.removeClips((clip) => clip.source === 'guide' && clip.takeId === take.takeId)
  let track = store.project.tracks.find((item) => item.input === `remote:${take.peerId}`)
  if (!track) {
    store.ensureRemoteTrack(take.peerId, take.peerName)
    track = store.project.tracks.find((item) => item.input === `remote:${take.peerId}`)
  }
  if (!track) return
  const bufferId = uid('buf')
  store.addAsset({ id: bufferId, name: `${take.peerName} take`, sampleRate: engine.sampleRate, channels })
  store.addAudioClip(track.id, {
    id: uid('clip'),
    name: `${take.peerName} aligned`,
    bufferId,
    startSample: Math.max(0, take.placeAtSample),
    offsetSamples: 0,
    durationSamples: channels[0].length,
    fadeInSamples: 32,
    fadeOutSamples: 64,
    gain: 1,
    source: 'aligned-take',
    peerId: take.peerId,
    takeId: take.takeId,
    alignmentMs: take.compensationMs,
  })
  store.toast(
    take.silent
      ? `${take.peerName} take arrived, but it is silent. Check their performance mic.`
      : `${take.peerName} aligned −${take.compensationMs.toFixed(0)} ms. ${take.detail}`,
    take.silent ? 'warn' : 'good',
  )
}
