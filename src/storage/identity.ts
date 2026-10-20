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

export function clearActiveSession() {
  const current = readIdentity()
  if (!current) return
  writeIdentity({ ...current, code: '' })
  const url = new URL(location.href)
  if (url.searchParams.has('session')) {
    url.searchParams.delete('session')
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }
}
