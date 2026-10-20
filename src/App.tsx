import { useEffect, useRef, useState } from 'react'
import { AudioEngine } from './audio/engine'
import { renderDemoLoop } from './model/demo'
import { uid, type AudioClip } from './model/types'
import type { IncomingTake } from './remote/session'
import { SessionClient } from './remote/session'
import { listProjects, loadProject, saveProject, base64ToBytes, bytesToBase64 } from './storage/idb'
import { ProjectStore, seedDemoProject } from './state/store'
import { decodeWavPCM, encodeWav, linearResample } from './model/wav'
import { guestStartPerf, scheduleLeadMs } from './model/sessionSync'
import { ArrangeView } from './ui/ArrangeView'
import { MixerView } from './ui/MixerView'
import { PianoRoll } from './ui/PianoRoll'
import { SessionView } from './ui/SessionView'
import { TransportBar } from './ui/TransportBar'
import { VideoDock } from './ui/VideoDock'
import { downloadBlob } from './ui/format'

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
  const [version, setVersion] = useState(0)
  const [surface, setSurface] = useState<'studio' | 'artist'>('studio')
  const [dock, setDock] = useState(380)
  const [dockEdge, setDockEdge] = useState<'right' | 'bottom'>('right')
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinName, setJoinName] = useState(store.project.name ? localStorage.getItem('cueharbor-name') || 'Artist' : 'Artist')
  const [saved, setSaved] = useState<{ id: string; name: string; savedAt: number }[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const projectFileRef = useRef<HTMLInputElement>(null)
  const takeRef = useRef<{ id: string; endSample: number } | null>(null)
  const armedPeers = useRef(new Set<string>())
  const launchKey = useRef('')
  const publishTimer = useRef(0)
  const pendingFollow = useRef<Record<string, unknown> | null>(null)

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
        if (session.state.preferLocalBacking) void followPlay(cmd)
        else engine.seek(Number(cmd.timelineSample) || 0)
      } else if (action === 'stop') {
        pendingFollow.current = null
        engine.stop()
      }
      else if (action === 'seek') {
        engine.seek(Number(cmd.timelineSample) || 0)
      }
    })
    const params = new URLSearchParams(location.search)
    const code = params.get('session')
    if (code) {
      setJoinCode(code.toUpperCase())
      setJoinOpen(true)
      setSurface('artist')
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
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      if (event.code === 'Space') {
        event.preventDefault()
        if (engine.status === 'stopped') void play()
        else void stop()
      } else if (event.key.toLowerCase() === 'r' && !event.metaKey && !event.ctrlKey) void record()
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
      } else if (event.key === 'Delete' || event.key === 'Backspace') store.deleteSelectedClip()
      else if (event.key.toLowerCase() === 'b') store.splitSelected(engine.positionSamples)
      else if (event.key.toLowerCase() === 'l') store.toggle('loopEnabled')
      else if (event.key === 'Home') void locate(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function ready() {
    await engine.resume()
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
    engine.refreshClockAnchor()
    const hostPerf = performance.now() + lead
    session.broadcastTransport({
      action: 'play',
      timelineSample: Math.round(sample),
      hostPerfAtSample: hostPerf,
      mode,
      tempo: store.project.tempo,
    })
    await engine.playAtPerf(sample, hostPerf, mode)
  }

  async function followPlay(cmd: Record<string, unknown>) {
    await ready()
    if (!session.state.preferLocalBacking) return
    const offset = session.hostOffsetMs()
    const hostPerf = Number(cmd.hostPerfAtSample) || performance.now()
    const localPerf = offset == null ? performance.now() : guestStartPerf(hostPerf, offset)
    const mode = cmd.mode === 'session' ? 'session' : 'arrangement'
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
    const lead = scheduleLeadMs(session.primaryOneWay()?.ms ?? 40)
    engine.refreshClockAnchor()
    const hostPerf = performance.now() + lead
    if (!alreadyPlaying) {
      session.broadcastTransport({
        action: 'play',
        timelineSample: fromSample,
        hostPerfAtSample: hostPerf,
        mode: 'arrangement',
        tempo: store.project.tempo,
      })
    }
    await engine.beginRecord({
      fromSample,
      inputs,
      countIn: store.project.countIn && !alreadyPlaying,
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

  async function copyInvite() {
    const code = session.state.code
    if (!code) return
    const url = `${location.origin}/?session=${code}`
    try {
      await navigator.clipboard.writeText(url)
      store.toast('Invite link copied. Send it to the artist.', 'good')
    } catch {
      store.toast(url, 'warn')
    }
  }

  async function bounce() {
    await ready()
    const wav = await engine.exportMix(store.project, store.buffers)
    downloadBlob(`${store.project.name.replace(/\s+/g, '-').toLowerCase()}.wav`, new Blob([wav], { type: 'audio/wav' }))
    store.toast('Mix bounced to WAV.', 'good')
  }

  async function persist() {
    await saveProject(store.project, store.buffers)
    store.toast('Saved in this browser.', 'good')
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

  const one = session.primaryOneWay()
  const showRoll = store.view === 'arrange' && store.selectedMidiClipId

  return (
    <div className={`shell ${surface}`} style={{ ['--dock' as string]: `${dock}px` }} data-version={version}>
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
            <p>Studio</p>
          </div>
        </div>
        <input className="project-name" value={store.project.name} onChange={(event) => store.renameProject(event.target.value)} />
        <div className="views">
          {(['arrange', 'mix', 'session'] as const).map((view) => (
            <button key={view} className={store.view === view ? 'active' : ''} onClick={() => { setSurface('studio'); store.setView(view) }}>
              {view}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {session.state.role === 'host' && session.state.code && (
          <button className="text-btn primary" onClick={() => void copyInvite()}>
            Copy invite link
          </button>
        )}
        {session.state.status === 'live' && <div className="latency-pill">monitor {one ? `${one.ms.toFixed(0)} ms` : '…'}</div>}
        <div className="top-actions">
          <button className="text-btn" onClick={() => void persist()}>Save</button>
          <button className="text-btn" onClick={() => void openLibrary()}>Library</button>
          <button className="text-btn" onClick={exportFile}>File</button>
          <button className="text-btn" onClick={() => projectFileRef.current?.click()}>Open</button>
          <button className="text-btn" onClick={() => fileRef.current?.click()}>Import</button>
          <button className="text-btn" onClick={() => void bounce()}>Bounce</button>
          <button className="text-btn" onClick={() => store.addTrack('audio')}>+ Audio</button>
          <button className="text-btn" onClick={() => store.addTrack('midi')}>+ Inst</button>
          <button className="text-btn" onClick={() => setSurface(surface === 'studio' ? 'artist' : 'studio')}>
            {surface === 'studio' ? 'Artist view' : 'Studio'}
          </button>
          <button className="text-btn" onClick={() => setDockEdge(dockEdge === 'right' ? 'bottom' : 'right')}>
            Dock {dockEdge === 'right' ? 'bottom' : 'right'}
          </button>
        </div>
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
        />
      )}
      <div className={`workspace ${dockEdge === 'bottom' && surface === 'studio' ? 'dock-bottom' : ''}`}>
        {surface === 'studio' && (
          <div className="main-pane">
            <div className="editor">
              {store.view === 'arrange' && <ArrangeView store={store} engine={engine} session={session} onSeek={(sample) => void locate(sample)} />}
              {store.view === 'mix' && <MixerView store={store} engine={engine} />}
              {store.view === 'session' && <SessionView store={store} />}
            </div>
            {showRoll && <PianoRoll store={store} />}
          </div>
        )}
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
            session={session}
            engine={engine}
            onCreate={() => {
              void engine.resume()
              setSurface('studio')
              session.connect({ name: joinName || 'Engineer', create: true })
            }}
            onJoin={() => setJoinOpen(true)}
          />
        </div>
      </div>
      <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={(event) => void importAudio(event.target.files)} />
      <input ref={projectFileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importProject(event.target.files?.[0] || null)} />
      {joinOpen && (
        <div className="modal-back">
          <div className="modal">
            <h2>Join the session</h2>
            <p>No install. Headphones on. You’ll hear the cue as fast as the link allows, and your take is recorded locally so it lands on the grid.</p>
            <div className="stack">
              <input value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="Your name" />
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Invite code" />
              <div className="row-btns">
                <button className="text-btn" onClick={() => setJoinOpen(false)}>Cancel</button>
                <button
                  className="text-btn primary"
                  onClick={() => {
                    void engine.resume()
                    session.connect({ name: joinName || 'Artist', code: joinCode.trim() })
                    setJoinOpen(false)
                    setSurface('artist')
                  }}
                >
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
  store.toast(`${take.peerName} aligned −${take.compensationMs.toFixed(0)} ms. ${take.detail}`, 'good')
}
