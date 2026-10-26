import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AudioEngine } from '../audio/engine'
import type { Participant, SessionClient } from '../remote/session'
import { mediaStatus } from '../model/media'
import { VIDEO_BITRATES } from '../model/codecs'
import { ms } from './format'

export function VideoDock({
  session,
  engine,
  simple,
  onCreate,
  onJoin,
  onNewSession,
}: {
  session: SessionClient
  engine: AudioEngine
  simple?: boolean
  onCreate: () => void
  onJoin: () => void
  onNewSession: () => void
}) {
  const state = session.state
  const [tab, setTab] = useState<'people' | 'chat' | 'signal'>('signal')
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [levels, setLevels] = useState({ input: 0, talk: 0 })
  const inviteUrl = state.code ? `${location.origin}/?session=${state.code}` : ''
  const root = useRef<HTMLDivElement>(null)
  const popRoot = useRef<Root | null>(null)
  const popWindow = useRef<Window | null>(null)
  const [popped, setPopped] = useState(false)
  useEffect(() => {
    const dock = root.current
    if (!dock) return
    const visible = new Set<string>()
    const paint = () => session.setIncomingVideo([...visible])
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.peer || ''
          if (!id || id === session.state.selfId) continue
          if (entry.isIntersecting && entry.intersectionRatio >= 0.15) visible.add(id)
          else visible.delete(id)
        }
        paint()
      },
      { threshold: [0, 0.15, 0.6] },
    )
    const watch = () => {
      observer.disconnect()
      visible.clear()
      for (const tile of dock.querySelectorAll<HTMLElement>('.tile[data-peer]')) {
        if (tile.dataset.peer === session.state.selfId) continue
        observer.observe(tile)
      }
    }
    watch()
    const frame = window.requestAnimationFrame(watch)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      session.setIncomingVideo([])
    }
  }, [session, state.participants.map((person) => person.id).join(), state.selfId])

  useEffect(() => {
    let timer = 0
    const tick = () => {
      const next = engine.levels()
      setLevels((prev) => (Math.abs(prev.input - next.input) < 0.02 ? prev : { input: next.input, talk: next.talk }))
      timer = window.setTimeout(tick, 100)
    }
    timer = window.setTimeout(tick, 100)
    return () => window.clearTimeout(timer)
  }, [engine])

  const admitted = state.participants.filter((person) => person.admitted)
  const waiting = state.participants.filter((person) => !person.admitted && person.role !== 'host')
  const featured = state.activeSpeakerId
  const one = session.primaryOneWay()
  const link = mediaStatus({
    turn: state.turn,
    turnError: state.turnError,
    links: Object.values(state.media),
    live: state.status === 'live',
  })

  function startNewSession() {
    const others = state.participants.some((person) => person.id !== state.selfId)
    const inRoom = state.status === 'live' || state.status === 'waiting' || state.status === 'reconnecting'
    if (inRoom && others && !window.confirm('Leave this session and start a new one?')) return
    onNewSession()
  }

  async function popOut(event: MouseEvent<HTMLButtonElement>) {
    const here = event.currentTarget.ownerDocument.defaultView
    const pip = window.documentPictureInPicture
    if (here && pip?.window && here === pip.window) {
      pip.window.close()
      return
    }
    if (!pip) {
      session.note('Picture-in-picture pop-out needs a Chromium browser.')
      return
    }
    const win = await pip.requestWindow({ width: 960, height: 640 })
    copyDockStyles(win)
    win.document.body.style.margin = '0'
    win.document.body.style.background = '#101614'
    win.document.body.style.height = '100%'
    const mount = win.document.createElement('div')
    mount.style.height = '100%'
    win.document.body.appendChild(mount)
    const dockRoot = createRoot(mount)
    popRoot.current = dockRoot
    popWindow.current = win
    dockRoot.render(<LiveDock session={session} engine={engine} simple={simple} onCreate={onCreate} onJoin={onJoin} onNewSession={onNewSession} />)
    setPopped(true)
    win.addEventListener('pagehide', () => {
      dockRoot.unmount()
      if (popRoot.current === dockRoot) popRoot.current = null
      popWindow.current = null
      setPopped(false)
    })
  }

  if (popped) {
    return (
      <aside className="dock">
        <div className="dock-placeholder">
          <p>The session is in its own window. Mute, camera, chat, and admit stay in sync with this studio.</p>
          <button className="text-btn primary" onClick={() => popWindow.current?.focus()}>
            Show session window
          </button>
          <button className="text-btn" onClick={() => popWindow.current?.close()}>
            Dock again
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className={`dock ${simple ? 'simple' : ''}`} ref={root}>
      <div className="dock-resize" />
      <div className="dock-bar">
        <strong>{state.code ? `Session ${state.code}` : 'Remote session'}</strong>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => session.setMonitorMode(state.monitorMode === 'opus' ? 'pcm' : 'opus')} title="Monitor path">
          {state.monitorMode === 'opus' ? 'Opus 10ms' : 'PCM'}
        </button>
        <button className="icon-btn pop-out" onClick={(event) => void popOut(event)} title="Pop out">
          ⧉
        </button>
        <button type="button" id="new-session" className="text-btn new-session" onClick={startNewSession}>
          New session
        </button>
      </div>
      <div className="dock-body">
      {state.usageNotice && <div className="media-banner bad">{state.usageNotice}</div>}
      {state.hostLeft && <div className="media-banner bad">The host left this session.</div>}
      {!state.hostLeft && link && <div className={`media-banner ${link.tone}`}>{link.text}</div>}
      {(state.status === 'live' || state.status === 'waiting' || state.status === 'reconnecting') && (
        <details className="connection-details">
          <summary>Connection details</summary>
          <p>{session.onScreenCount() == null ? 'Waiting for the video layout.' : `Video tiles on screen: ${session.onScreenCount()}.`}</p>
          {Object.keys(state.media).length === 0 && <p>No peer connection yet.</p>}
          {Object.entries(state.media).map(([id, item]) => {
            const person = state.participants.find((entry) => entry.id === id)
            const kind = item.localType || (item.path === 'relay' ? 'relay' : item.path === 'direct' ? 'host' : 'none yet')
            return (
              <p key={id}>
                {person?.name || 'Peer'}: {item.connection} · ice {item.ice} · {item.signaling || 'signaling'} · {kind}
                {item.remoteType ? ` / ${item.remoteType}` : ''}
              </p>
            )
          })}
        </details>
      )}
      {simple && (
        <div className="artist-card">
          <p>Headphones on. You should hear the session, not your own voice coming back.</p>
          <div className="meter tall">
            <b style={{ width: `${Math.min(100, levels.input * 320)}%` }} />
          </div>
          <strong className={engine.status === 'recording' ? 'rec-label' : ''}>
            {engine.status === 'recording' ? 'Recording' : engine.status === 'playing' ? 'Playing' : engine.status === 'counting-in' ? 'Count-in' : 'Stopped'}
          </strong>
        </div>
      )}
      {inviteUrl && (
        <div className="invite-card">
          <span>Send this link to the artist</span>
          <strong>{inviteUrl}</strong>
          <button
            className="text-btn primary"
            onClick={(event) => {
              const view = event.currentTarget.ownerDocument.defaultView || window
              void view.navigator.clipboard.writeText(inviteUrl).then(
                () => {
                  setCopied(true)
                  view.setTimeout(() => setCopied(false), 1600)
                  session.note('Invite link copied.')
                },
                () => session.note(`Copy this link: ${inviteUrl}`),
              )
            }}
          >
            {copied ? 'Copied' : 'Copy invite link'}
          </button>
        </div>
      )}
      {state.status === 'idle' || state.status === 'error' ? (
        <div className="empty-session">
          <p>Bring an artist, a producer, and a listener into the same room. The cue stays as fast as the path allows. The printed take is aligned after the fact, so the record is on the grid.</p>
          {state.error && <p className="hint">{state.error}</p>}
          <button type="button" className="text-btn primary" onClick={onCreate}>
            Create invite
          </button>
          <button type="button" className="text-btn new-session" onClick={startNewSession}>
            New session
          </button>
          <button type="button" className="text-btn" id="join-with-code" onClick={onJoin}>
            Join with a code
          </button>
        </div>
      ) : (
        <div className={`stage ${featured ? 'speaker' : 'gallery'}`}>
          <Tile session={session} peerId={state.selfId || 'self'} self name={state.name} speaking={state.activeSpeakerId === state.selfId} hand={state.hand} />
          {admitted
            .filter((person) => person.id !== state.selfId)
            .map((person) => (
              <Tile
                key={person.id}
                session={session}
                peerId={person.id}
                name={person.name}
                speaking={state.activeSpeakerId === person.id}
                hand={person.hand}
                reaction={state.reactions[person.id]?.emoji}
                featured={person.id === featured}
              />
            ))}
        </div>
      )}
      <div className="call-controls">
        <button className={`t-btn ${state.talkOn ? 'on' : ''}`} onClick={() => void session.setTalk(!state.talkOn)} title="Talkback">
          {state.talkOn ? 'Mic' : 'Mic off'}
        </button>
        <button className={`t-btn ${state.musicOn ? 'on' : ''}`} onClick={() => void session.setMusic(!state.musicOn)} title="Performance or cue send">
          {state.role === 'host' ? 'Cue' : 'Perf'}
        </button>
        <button className={`t-btn ${state.camOn ? 'on' : ''}`} onClick={() => void session.setCam(!state.camOn)}>
          Cam
        </button>
        <button className={`t-btn ${state.screenOn ? 'on' : ''}`} onClick={() => void session.setScreen(!state.screenOn)}>
          Share
        </button>
        <button className={`t-btn ${state.hand ? 'on' : ''}`} onClick={() => session.setHand(!state.hand)}>
          Hand
        </button>
        {['👍', '🎧', '🔥'].map((emoji) => (
          <button key={emoji} className="t-btn" onClick={() => session.react(emoji)}>
            {emoji}
          </button>
        ))}
        {state.code && (
          <button className="text-btn warn" onClick={() => session.leave()}>
            Leave
          </button>
        )}
      </div>
      <div>
        <div className="side-tabs">
          {(['signal', 'people', 'chat'] as const).map((item) => (
            <button key={item} className={`text-btn ${tab === item ? 'primary' : ''}`} onClick={() => setTab(item)}>
              {item}
            </button>
          ))}
        </div>
        {tab === 'signal' && (
          <div className="panel stats">
            <div>
              Live monitor <b>{one ? ms(one.ms) : '—'}</b> ± {one ? ms(one.uncertaintyMs) : '—'} via {one?.source || 'not measured'}
            </div>
            <div>
              Printed take removes that path. Device out <b>{ms(engine.outputLatencyMs, 1)}</b> · in <b>{ms(engine.inputLatencyMs, 1)}</b>
            </div>
            <div>
              Loopback <b>{ms(state.loopbackMs, 1)}</b> · Opus ping <b>{ms(state.audioPingMs, 1)}</b>
            </div>
            <div className="meter" style={{ height: 8, width: '100%', margin: '6px 0' }}>
              <b style={{ width: `${Math.min(100, levels.input * 320)}%`, height: '100%' }} />
            </div>
            <label className="field" style={{ marginTop: 8 }}>
              Video size
              <select value={state.videoBitrate} onChange={(event) => session.setVideoBitrate(Number(event.target.value))}>
                {VIDEO_BITRATES.map((bitrate) => (
                  <option key={bitrate} value={bitrate}>
                    {bitrate / 1000} kbps
                  </option>
                ))}
              </select>
            </label>
            <div className="hint">Performance meter (processing off). Talkback is a separate channel with echo control.</div>
            <div className="hint">{state.localSend}</div>
            {Object.entries(state.latency).map(([id, latency]) => (
              <div key={id}>
                {state.participants.find((person) => person.id === id)?.name}: RTT {ms(latency.rttMs)} · jitter {ms(latency.jitterMs, 1)} · loss{' '}
                {latency.packetLossPct == null ? '—' : `${latency.packetLossPct.toFixed(1)}%`} · buffer {ms(latency.jitterBufferMs, 1)} · clock{' '}
                {ms(latency.clockRttMs, 1)}
              </div>
            ))}
            <div className="row" style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="text-btn" onClick={() => void session.calibrate()}>
                Calibrate I/O
              </button>
              <button className="text-btn" onClick={() => void session.measureOpusPath()}>
                Ping cue path
              </button>
              <button className={`text-btn ${state.jamEnabled ? 'primary' : ''}`} onClick={() => session.setJam(!state.jamEnabled)}>
                Jam mode
              </button>
            </div>
            {state.jamEnabled && (
              <label className="field" style={{ marginTop: 8 }}>
                Host monitor delay
                <input type="number" value={state.jamDelayMs} onChange={(event) => session.setJam(true, Number(event.target.value))} />
              </label>
            )}
            <DevicePick session={session} />
            {inviteUrl && <div className="linkbox">{inviteUrl}</div>}
            {state.takeProgress != null && <div>Take transfer {Math.round(state.takeProgress * 100)}%</div>}
            {state.log.slice(-3).map((line, index) => (
              <div key={index} className="hint">
                {line}
              </div>
            ))}
          </div>
        )}
        {tab === 'people' && (
          <div className="panel">
            {waiting.length > 0 && (
              <div className="waiting">
                Waiting room
                {waiting.map((person) => (
                  <div className="person" key={person.id}>
                    <span>{person.name}</span>
                    {state.role === 'host' && (
                      <span>
                        <button className="text-btn primary" onClick={() => session.admit(person.id)}>
                          Admit
                        </button>
                        <button className="text-btn" onClick={() => session.reject(person.id)}>
                          Reject
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {admitted.map((person) => (
              <PersonRow key={person.id} person={person} session={session} />
            ))}
          </div>
        )}
        {tab === 'chat' && (
          <div className="panel">
            {state.chat.map((message) => (
              <div key={message.id} className="chat-line">
                <span>
                  <small>{message.name}</small>
                  <div>{message.text}</div>
                </span>
              </div>
            ))}
            <form
              className="chat-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (!draft.trim()) return
                session.sendChat(draft.trim())
                setDraft('')
              }}
            >
              <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message the room" />
              <button className="text-btn" type="submit">
                Send
              </button>
            </form>
          </div>
        )}
      </div>
      </div>
    </aside>
  )
}

function LiveDock(props: { session: SessionClient; engine: AudioEngine; simple?: boolean; onCreate: () => void; onJoin: () => void; onNewSession: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => props.session.subscribe(() => bump((n) => n + 1)), [props.session])
  useEffect(() => props.engine.subscribe(() => bump((n) => n + 1)), [props.engine])
  return <VideoDock {...props} />
}

function copyDockStyles(win: Window) {
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    win.document.head.appendChild(node.cloneNode(true))
  }
  for (const sheet of document.styleSheets) {
    try {
      const style = win.document.createElement('style')
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n')
      win.document.head.appendChild(style)
    } catch {
      /* a cross-origin sheet cannot be read */
    }
  }
}

function playVideo(el: HTMLVideoElement | null, stream: MediaStream | null, muted: boolean) {
  if (!el) return
  const playable = stream && stream.getVideoTracks().length ? stream : null
  el.autoplay = true
  el.playsInline = true
  el.muted = muted
  el.setAttribute('playsinline', 'true')
  el.setAttribute('webkit-playsinline', 'true')
  if (!playable) {
    if (el.srcObject) el.srcObject = null
    return
  }
  const current = el.srcObject instanceof MediaStream ? el.srcObject : null
  const nextId = playable.getVideoTracks()[0]?.id
  const same = current?.getVideoTracks()[0]?.id === nextId && nextId
  if (!same) el.srcObject = playable
  const start = () => {
    void el.play().catch(() => undefined)
  }
  start()
  el.onloadedmetadata = start
  const track = playable.getVideoTracks()[0]
  if (track) track.onunmute = start
}

function Tile({
  session,
  peerId,
  name,
  self,
  speaking,
  hand,
  reaction,
  featured,
}: {
  session: SessionClient
  peerId: string
  name: string
  self?: boolean
  speaking?: boolean
  hand?: boolean
  reaction?: string
  featured?: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const screenRef = useRef<HTMLVideoElement>(null)
  const [hear, setHear] = useState(false)
  useEffect(() => {
    playVideo(ref.current, session.videoStream(peerId, self ? 'self' : 'camera'), self || !hear)
    playVideo(screenRef.current, self ? null : session.videoStream(peerId, 'screen'), true)
  }, [session, peerId, self, hear, session.state.camOn, session.state.screenOn, session.state.participants, session.state.mediaTick])
  const screenOn = !self && session.state.participants.find((person) => person.id === peerId)?.screen
  return (
    <div className={`tile ${speaking ? 'speaking' : ''} ${featured ? 'featured' : ''}`} data-peer={peerId}>
      <video ref={ref} autoPlay playsInline muted={self || !hear} />
      {screenOn && <video ref={screenRef} autoPlay playsInline muted style={{ height: 90 }} />}
      {!self && (
        <button
          className="text-btn tile-audio"
          type="button"
          onClick={() => {
            const next = !hear
            setHear(next)
            const el = ref.current
            if (!el) return
            el.muted = !next
            void el.play().catch(() => undefined)
          }}
        >
          {hear ? 'Mute tile' : 'Unmute tile'}
        </button>
      )}
      {!session.state.camOn && self && <div className="placeholder">Camera off</div>}
      {!self && !session.videoStream(peerId, 'camera') && (
        <div className="placeholder">{session.state.media[peerId]?.connection === 'connected' ? 'Camera off' : 'No video yet'}</div>
      )}
      <div className="cap">
        <span>{self ? `${name} · you` : name}</span>
        {hand && <span>✋</span>}
      </div>
      {reaction && <div className="react">{reaction}</div>}
    </div>
  )
}

function PersonRow({ person, session }: { person: Participant; session: SessionClient }) {
  const self = person.id === session.state.selfId
  return (
    <div className="person">
      <div className="who">
        <span>
          {person.name} {person.role === 'host' ? '· host' : ''}
        </span>
        <small>
          {person.hand ? 'hand raised · ' : ''}
          {person.music ? 'performance on' : 'performance muted'}
          {person.screen ? ' · sharing' : ''}
        </small>
      </div>
      {session.state.role === 'host' && !self && (
        <span>
          <button className="text-btn" onClick={() => session.forceMute(person.id, !person.mutedByHost)}>
            {person.mutedByHost ? 'Unmute' : 'Mute'}
          </button>
          <button className="text-btn" onClick={() => session.remove(person.id)}>
            Remove
          </button>
        </span>
      )}
    </div>
  )
}

function DevicePick({ session }: { session: SessionClient }) {
  const mics = session.state.devices.filter((device) => device.kind === 'audioinput')
  const cams = session.state.devices.filter((device) => device.kind === 'videoinput')
  const outs = session.state.devices.filter((device) => device.kind === 'audiooutput')
  return (
    <div className="knobs" style={{ marginTop: 8 }}>
      <label>
        Mic
        <select value={session.state.micId} onChange={(event) => void session.setDevices({ micId: event.target.value })}>
          <option value="">Default</option>
          {mics.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Camera
        <select value={session.state.camId} onChange={(event) => void session.setDevices({ camId: event.target.value })}>
          <option value="">Default</option>
          {cams.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Output
        <select value={session.state.outId} onChange={(event) => void session.setDevices({ outId: event.target.value })}>
          <option value="">Default</option>
          {outs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
