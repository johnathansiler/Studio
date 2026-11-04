export interface DeviceIdentity {
  participantId: string
  name: string
  role: 'host' | 'guest'
  code: string
  camOn: boolean
  micId: string
  outId: string
  musicOn: boolean
  jamEnabled: boolean
  jamDelayMs: number
  monitorMode: 'opus' | 'pcm'
  transportMode: 'arrangement' | 'session'
}

const KEY = 'cueharbor-identity'
const PARTICIPANT = 'cueharbor-participant'

export function deviceParticipantId(): string {
  const existing = localStorage.getItem(PARTICIPANT) || sessionStorage.getItem(PARTICIPANT)
  if (existing) {
    localStorage.setItem(PARTICIPANT, existing)
    sessionStorage.setItem(PARTICIPANT, existing)
    return existing
  }
  const id = crypto.randomUUID()
  localStorage.setItem(PARTICIPANT, id)
  sessionStorage.setItem(PARTICIPANT, id)
  return id
}

export function readIdentity(): DeviceIdentity | null {
  const raw = localStorage.getItem(KEY) || sessionStorage.getItem(KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeviceIdentity
    if (!parsed || typeof parsed.participantId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function writeIdentity(identity: DeviceIdentity) {
  const json = JSON.stringify(identity)
  localStorage.setItem(KEY, json)
  sessionStorage.setItem(KEY, json)
  localStorage.setItem(PARTICIPANT, identity.participantId)
  sessionStorage.setItem(PARTICIPANT, identity.participantId)
  localStorage.setItem('cueharbor-name', identity.name)
}

/** Drop `session`, `invite`, and `role` so a reload is a normal open. */
export function withoutInviteParams(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.delete('session')
  params.delete('invite')
  params.delete('role')
  const next = params.toString()
  return next ? `?${next}` : ''
}

export function replaceInviteUrl() {
  try {
    const next = withoutInviteParams(location.search)
    if ((location.search || '') === next) return
    history.replaceState(null, '', `${location.pathname}${next}${location.hash}`)
  } catch {
    /* a non-browser test has no history */
  }
}

/** Forget a room saved by an older build. Name and devices stay. */
export function forgetStoredCollab() {
  try {
    const current = readIdentity()
    if (current?.code) writeIdentity({ ...current, code: '' })
    const drop: string[] = []
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i)
      if (key && key.startsWith('cueharbor-resume:')) drop.push(key)
    }
    for (const key of drop) sessionStorage.removeItem(key)
  } catch {
    /* private mode has nothing to forget */
  }
}

export function clearActiveSession() {
  const current = readIdentity()
  if (current) writeIdentity({ ...current, code: '', role: 'host' })
  replaceInviteUrl()
}
