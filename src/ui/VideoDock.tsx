import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AudioEngine } from '../audio/engine'
import type { Participant, SessionClient } from '../remote/session'
import { previewPlayback, type ConnectionGrade } from '../model/callVideo'
import { mediaStatus } from '../model/media'
import { parseCollabTarget } from '../model/negotiate'
import { CALL_COPY, copyOf } from './chrome'
import { collabChoosing, connectionLine, linkLooksFailed, personConnection, selfConnection, worstConnection } from './collabTab'
import { SETUP_PLAIN } from './collabCopy'
import { useFormFactor } from './form'
import { TipButton } from './Hint'
import { VersionsList } from './VersionsList'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'
import { ACCESS_COPY, ACCESS_ROLES, mayWriteProject, roleShareUrl, type CollabAccess } from '../state/ops'
import { shareSessionLink } from './share'

export function VideoDock({
  session,
  engine,
  store,
  versionTick,
  simple,
  onCreate,
  onJoinInvite,
  onSaveVersion,
}: {
  session: SessionClient
  engine: AudioEngine
  store: ProjectStore
  versionTick: number
  simple?: boolean
  onCreate: () => void
  onJoinInvite: (input: { name: string; code: string; invite: string }) => void
  onSaveVersion: () => void
}) {
  const state = session.state
  const form = useFormFactor()
  const call = (id: string) => copyOf(CALL_COPY, id)
  const [tab, setTab] = useState<'people' | 'chat' | 'versions'>('people')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [linkNote, setLinkNote] = useState('')
  const [joinForm, setJoinForm] = useState(false)
  const [joinDraft, setJoinDraft] = useState('')
  const [nameDraft, setNameDraft] = useState(state.name)
  const [joinNote, setJoinNote] = useState('')
  const [draft, setDraft] = useState('')
  const [levels, setLevels] = useState({ input: 0, talk: 0 })
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
  const link = mediaStatus({
    turn: state.turn,
    turnError: state.turnError,
    links: Object.values(state.media),
    live: state.status === 'live',
  })

  const choosing = collabChoosing(state.status)
  const wideRoom = form !== 'phone'
  const grades = [...waiting, ...admitted].map((person) => gradeForPerson(session, person))
  const overall = worstConnection(grades.length ? grades : [personConnection({
    self: true,
    status: state.status,
    link: undefined,
    oneWayMs: session.primaryOneWay()?.ms ?? null,
  })])
  useEffect(() => {
    if (!choosing) setJoinForm(false)
  }, [choosing])
  const startNote = state.error
    || (state.status === 'rejected' ? 'The host declined this session.' : '')
    || (state.status === 'removed' ? 'You were removed from this session.' : '')

  function submitJoin() {
    const target = parseCollabTarget(joinDraft)
    if (!target.code) {
      setJoinNote('Enter a code or paste a link.')
      return
    }
    setJoinNote('')
    onJoinInvite({ name: nameDraft.trim() || state.name || 'Artist', code: target.code, invite: target.invite })
  }

  function sessionReady(status: string, code?: string) {
    return Boolean(code && (status === 'live' || status === 'waiting' || status === 'reconnecting'))
  }

  function ensureSessionCode(): Promise<string> {
    if (sessionReady(session.state.status, session.state.code)) return Promise.resolve(session.state.code || '')
    onCreate()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        stop()
        reject(new Error('timeout'))
      }, 8000)
      const stop = session.subscribe(() => {
        if (sessionReady(session.state.status, session.state.code)) {
          window.clearTimeout(timer)
          stop()
          resolve(session.state.code || '')
        } else if (session.state.status === 'error') {
          window.clearTimeout(timer)
          stop()
          reject(new Error(session.state.error || 'error'))
        }
      })
    })
  }

  async function copyInviteLink(event: MouseEvent<HTMLButtonElement>) {
    const view = event.currentTarget.ownerDocument.defaultView || window
    try {
      const code = await ensureSessionCode()
      let url = `${view.location.origin}/?session=${code}`
      if (session.state.role === 'host') {
        try {
          const token = await session.requestInvite('view')
          url = roleShareUrl(view.location.origin, code, token, 'view')
        } catch {
          /* a code on its own still joins as view */
        }
      }
      const result = await shareSessionLink(url, { phone: form === 'phone' })
      if (result === 'copied' || result === 'shared') {
        setLinkNote('Link copied')
        view.setTimeout(() => setLinkNote((current) => (current === 'Link copied' ? '' : current)), 1600)
      } else if (result === 'failed') {
        setLinkNote(url)
      }
    } catch {
      session.note('The invite link did not arrive.')
    }
  }

  async function popOut(event?: MouseEvent<HTMLButtonElement>) {
    const here = event?.currentTarget.ownerDocument.defaultView || window
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
    dockRoot.render(<LiveDock session={session} engine={engine} store={store} versionTick={versionTick} simple={simple} onCreate={onCreate} onJoinInvite={onJoinInvite} onSaveVersion={onSaveVersion} />)
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
          <p>Session window is open.</p>
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
    <aside className={`dock ${simple ? 'simple' : ''}`} ref={root} data-collab-phase={choosing ? 'start' : 'room'}>
      <div className="dock-resize" />
      {!choosing && (
        <div className="dock-bar session-head">
          <strong>{state.code ? `Session ${state.code}` : 'Session'}</strong>
          <ConnectionMark grade={overall} />
        </div>
      )}
      <div className="dock-body">
      {!choosing && state.usageNotice && <div className="media-banner bad">{state.usageNotice}</div>}
      {!choosing && state.hostLeft && <div className="media-banner bad">The host left this session.</div>}
      {!choosing && !state.hostLeft && link && link.tone !== 'good' && <div className={`media-banner ${link.tone}`}>{link.text}</div>}
      {!choosing && simple && (
        <div className="artist-card">
          <div className="meter tall">
            <b style={{ width: `${Math.min(100, levels.input * 320)}%` }} />
          </div>
          {state.status !== 'live' && (
            <strong className={engine.status === 'recording' ? 'rec-label' : ''}>
              {engine.status === 'recording' ? 'Recording' : engine.status === 'playing' ? 'Playing' : engine.status === 'counting-in' ? 'Count-in' : 'Stopped'}
            </strong>
          )}
        </div>
      )}
      {choosing ? (
        <div className="collab-start" data-collab-start="open">
          {startNote && <p className="hint">{startNote}</p>}
          {joinForm ? (
            <form
              className="collab-join"
              onSubmit={(event) => {
                event.preventDefault()
                submitJoin()
              }}
            >
              <label className="collab-field">
                Your name
                <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} autoComplete="name" />
              </label>
              <label className="collab-field">
                Invite code or link
                <input
                  value={joinDraft}
                  onChange={(event) => setJoinDraft(event.target.value)}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              {joinNote && <p className="hint" role="status">{joinNote}</p>}
              <button type="submit" className="text-btn primary">Join</button>
              <button type="button" className="text-btn" onClick={() => { setJoinForm(false); setJoinNote('') }}>Back</button>
            </form>
          ) : (
            <>
              <TipButton className="text-btn primary" label={call('create').label} hint={call('create').hint} onClick={onCreate} />
              <TipButton id="join-with-code" className="text-btn" label={call('join').label} hint={call('join').hint} onClick={() => setJoinForm(true)} />
            </>
          )}
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
      {!choosing && (
        <div className="call-controls">
          <div className="call-pills">
            <TipButton className={`t-btn ${state.talkOn ? 'on' : ''}`} label={state.talkOn ? 'Mic on' : 'Mic off'} hint={call('mic').hint} pressed={state.talkOn} onClick={() => void session.setTalk(!state.talkOn)}>
              Mic
            </TipButton>
            <TipButton className={`t-btn ${state.camOn ? 'on' : ''}`} label={call('cam').label} hint={call('cam').hint} pressed={state.camOn} onClick={() => void session.setCam(!state.camOn)}>
              Cam
            </TipButton>
            <button type="button" className="text-btn primary copy-link" aria-label="Copy Link" onClick={(event) => void copyInviteLink(event)}>
              Copy Link
            </button>
            <button type="button" className="text-btn warn leave-btn" aria-label="Leave" onClick={() => session.leave()}>
              Leave
            </button>
            <TipButton
              className={`t-btn ${settingsOpen ? 'on' : ''}`}
              label={call('settings').label}
              hint={call('settings').hint}
              pressed={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              Setup
            </TipButton>
          </div>
          {linkNote && <span className="link-note" role="status">{linkNote}</span>}
        </div>
      )}
      {!choosing && settingsOpen && (
        <div className="settings-sheet" data-setup="open">
          <div className="setup-list">
            <SetupRow
              label={SETUP_PLAIN.hear.label}
              detail={SETUP_PLAIN.hear.detail}
              pressed={state.musicOn}
              onClick={() => void session.setMusic(!state.musicOn)}
            />
            <SetupRow
              label={SETUP_PLAIN.calibrate.label}
              detail={SETUP_PLAIN.calibrate.detail}
              onClick={() => void session.calibrate()}
            />
            {wideRoom && (
              <SetupRow
                label="Pop out"
                detail="Open the session in its own window."
                onClick={(event) => void popOut(event)}
              />
            )}
          </div>
          <DevicePick session={session} />
          {state.takeProgress != null && <div>Take {Math.round(state.takeProgress * 100)}%</div>}
        </div>
      )}
      {!choosing && (
      <div className="collab-lower" data-collab-layout={wideRoom && tab !== 'versions' ? 'split' : 'stack'}>
        <div className="side-tabs">
          {([
            ['people', 'People'],
            ['chat', 'Chat'],
            ['versions', 'Versions'],
          ] as const).map(([item, label]) => (
            <button key={item} type="button" data-tab={item} className={`text-btn ${tab === item ? 'active' : ''}`} onClick={() => setTab(item)}>
              {label}
            </button>
          ))}
        </div>
        {wideRoom && tab !== 'versions' ? (
          <div className="collab-split">
            <PeoplePanel session={session} admitted={admitted} waiting={waiting} />
            <ChatPanel session={session} draft={draft} onDraft={setDraft} />
          </div>
        ) : (
          <>
            {tab === 'people' && <PeoplePanel session={session} admitted={admitted} waiting={waiting} />}
            {tab === 'versions' && (
              <VersionsList
                projectId={store.project.id}
                tick={versionTick}
                canRestore={mayWriteProject(session.selfAccess())}
                onSave={onSaveVersion}
                onRestore={(project: Project) => store.restoreForEveryone(project)}
              />
            )}
            {tab === 'chat' && <ChatPanel session={session} draft={draft} onDraft={setDraft} />}
          </>
        )}
      </div>
      )}
      </div>
    </aside>
  )
}

function LiveDock(props: { session: SessionClient; engine: AudioEngine; store: ProjectStore; versionTick: number; simple?: boolean; onCreate: () => void; onJoinInvite: (input: { name: string; code: string; invite: string }) => void; onSaveVersion: () => void }) {
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

const playHooks = new WeakSet<MediaStreamTrack>()

function playVideo(el: HTMLVideoElement | null, stream: MediaStream | null, muted: boolean) {
  if (!el) return
  const live = stream?.getVideoTracks().filter((track) => track.readyState === 'live') ?? []
  const plan = previewPlayback(live[0] ?? null)
  el.autoplay = true
  el.playsInline = plan.playsInline
  el.muted = muted
  el.setAttribute('playsinline', 'true')
  el.setAttribute('webkit-playsinline', 'true')
  if (!plan.attach || !stream) {
    if (el.srcObject) el.srcObject = null
    return
  }
  const playable = live.length === stream.getVideoTracks().length ? stream : new MediaStream(live)
  const current = el.srcObject instanceof MediaStream ? el.srcObject : null
  const next = live[0]
  const currentLive = current?.getVideoTracks().find((track) => track.id === next.id && track.readyState === 'live')
  if (!currentLive) el.srcObject = playable
  const start = () => {
    if (!plan.play) return
    void el.play().then(
      () => { el.dataset.playError = '' },
      (error: unknown) => { el.dataset.playError = error instanceof Error ? error.name : 'play' },
    )
  }
  start()
  el.onloadedmetadata = start
  if (!playHooks.has(next)) {
    playHooks.add(next)
    const prior = next.onunmute
    next.onunmute = () => {
      start()
      if (typeof prior === 'function') prior.call(next, new Event('unmute'))
    }
  }
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
          aria-label={hear ? 'Mute tile' : 'Unmute tile'}
          onClick={() => {
            const next = !hear
            setHear(next)
            const el = ref.current
            if (!el) return
            el.muted = !next
            void el.play().catch(() => undefined)
          }}
        >
          {hear ? 'Mute' : 'Hear'}
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

function linkIsUp(link: { connection: string; ice: string } | undefined): boolean {
  if (!link) return false
  return link.connection === 'connected' || link.ice === 'connected' || link.ice === 'completed'
}

function gradeForPerson(session: SessionClient, person: Participant): ConnectionGrade {
  const self = person.id === session.state.selfId
  if (self) {
    const peers = session.state.participants.filter((other) => other.id !== person.id)
    const links = peers.map((other) => session.state.media[other.id])
    return selfConnection({
      status: session.state.status,
      oneWayMs: session.primaryOneWay()?.ms ?? null,
      peers: peers.length,
      linksUp: links.filter(linkIsUp).length,
      linksFailed: links.filter(linkLooksFailed).length,
    })
  }
  return personConnection({
    self: false,
    status: session.state.status,
    link: session.state.media[person.id],
    oneWayMs: session.state.latency[person.id]?.oneWayMs ?? null,
  })
}

function ConnectionMark({ grade }: { grade: ConnectionGrade }) {
  return (
    <p className="connection-word" data-grade={grade}>
      <span className="connection-dot" aria-hidden="true" />
      <span className="connection-label">{grade}</span>
      <span className="connection-detail">{connectionLine(grade)}</span>
    </p>
  )
}

function PeoplePanel({
  session,
  admitted,
  waiting,
}: {
  session: SessionClient
  admitted: Participant[]
  waiting: Participant[]
}) {
  return (
    <div className="panel people-panel">
      {waiting.length > 0 && (
        <div className="waiting">
          Waiting room
          {waiting.map((person) => (
            <div className="person" key={person.id}>
              <div className="who">
                <span className="person-name">{person.name}</span>
                <ConnectionMark grade={gradeForPerson(session, person)} />
              </div>
              {session.state.role === 'host' && (
                <span className="person-actions">
                  <button type="button" className="text-btn primary" onClick={() => session.admit(person.id)}>
                    Admit
                  </button>
                  <details className="person-menu">
                    <summary>Manage</summary>
                    <span className="person-actions">
                      <RoleSelect person={person} session={session} />
                      <button type="button" className="text-btn" onClick={() => session.reject(person.id)}>
                        Reject
                      </button>
                    </span>
                  </details>
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
  )
}

function ChatPanel({
  session,
  draft,
  onDraft,
}: {
  session: SessionClient
  draft: string
  onDraft: (value: string) => void
}) {
  return (
    <div className="panel chat-panel">
      <div className="chat-log">
        {session.state.chat.map((message) => (
          <div key={message.id} className="chat-line">
            <span>
              <small>{message.name}</small>
              <div>{message.text}</div>
            </span>
          </div>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!draft.trim()) return
          session.sendChat(draft.trim())
          onDraft('')
        }}
      >
        <input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Message the room" aria-label="Message the room" />
        <button className="text-btn" type="submit">
          Send
        </button>
      </form>
    </div>
  )
}

function accessWord(person: Participant) {
  if (person.role === 'host') return 'Host'
  return ACCESS_COPY[person.access || 'view'].label
}

function RoleSelect({ person, session }: { person: Participant; session: SessionClient }) {
  return (
    <label className="role-field">
      Role
      <select
        className="role-select"
        aria-label={`Role for ${person.name}`}
        value={person.access || 'view'}
        onChange={(event) => session.setAccess(person.id, event.target.value as CollabAccess)}
      >
        {ACCESS_ROLES.map((role) => (
          <option key={role} value={role}>
            {ACCESS_COPY[role].label}
          </option>
        ))}
      </select>
    </label>
  )
}

function PersonRow({ person, session }: { person: Participant; session: SessionClient }) {
  const self = person.id === session.state.selfId
  return (
    <div className="person">
      <div className="who">
        <span>
          <span className="person-name">{person.name}</span>
          {` · ${accessWord(person)}`}
        </span>
        <ConnectionMark grade={gradeForPerson(session, person)} />
        <small>
          {person.hand ? 'hand · ' : ''}
          {person.music ? 'perf' : 'muted'}
          {person.screen ? ' · sharing' : ''}
        </small>
      </div>
      {session.state.role === 'host' && !self && (
        <details className="person-menu">
          <summary>Manage</summary>
          <span className="person-actions">
            <RoleSelect person={person} session={session} />
            <button className="text-btn" onClick={() => session.forceMute(person.id, !person.mutedByHost)}>
              {person.mutedByHost ? 'Unmute' : 'Mute'}
            </button>
            <button className="text-btn" onClick={() => session.remove(person.id)}>
              Remove
            </button>
          </span>
        </details>
      )}
    </div>
  )
}

function SetupRow({ label, detail, onClick, pressed }: { label: string; detail: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void; pressed?: boolean }) {
  return (
    <div className="setup-row">
      <button type="button" className={`text-btn ${pressed ? 'primary' : ''}`} aria-label={label} onClick={onClick}>
        {label}
      </button>
      <p>{detail}</p>
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
