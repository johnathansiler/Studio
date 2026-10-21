import { baseIceConfig, staticTurnServer, withStun, type IceConfig, type IcePolicy, type IceServer, type TurnProvider } from '../src/model/media.ts'

export type { IceConfig }

interface Cache {
  expires: number
  stamp: string
  config: IceConfig
}

let cache: Cache | null = null

/** Credential env is part of the cache key, so a new key is visible on the next request. */
export function iceEnvStamp(env: NodeJS.ProcessEnv): string {
  return [
    env.CF_TURN_KEY_ID,
    env.CF_TURN_API_TOKEN,
    env.TURN_URL,
    env.TURN_USERNAME,
    env.TURN_CREDENTIAL,
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN,
    env.METERED_DOMAIN,
    env.METERED_API_KEY,
    env.ICE_TRANSPORT_POLICY,
  ].join('\n')
}

export async function currentIce(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<IceConfig> {
  const stamp = iceEnvStamp(env)
  const now = Date.now()
  if (cache && cache.stamp === stamp && cache.expires > now && cache.config.turn !== 'none' && !cache.config.turnError) return cache.config
  const config = await resolveIce(env, fetchImpl)
  const ttl = config.turn === 'none' || config.turnError ? 0 : 30 * 60 * 1000
  cache = { config, stamp, expires: now + ttl }
  return config
}

export function clearIceCache() {
  cache = null
}

export async function resolveIce(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<IceConfig> {
  const policy: IcePolicy = env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all'
  const extra: IceServer[] = []
  let turn: TurnProvider = 'none'
  let turnError: string | undefined

  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    try {
      extra.push(...(await cloudflareIce(env.CF_TURN_KEY_ID, env.CF_TURN_API_TOKEN, fetchImpl)))
      turn = 'cloudflare'
    } catch (error) {
      turnError = error instanceof Error ? error.message : 'Cloudflare TURN failed'
    }
  }
  if (!extra.length && env.TURN_URL && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    extra.push(staticTurnServer(env.TURN_URL, env.TURN_USERNAME, env.TURN_CREDENTIAL))
    turn = 'static'
    turnError = undefined
  } else if (!extra.length && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    try {
      extra.push(...(await twilioIce(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, fetchImpl)))
      turn = 'twilio'
      turnError = undefined
    } catch (error) {
      turnError = error instanceof Error ? error.message : 'Twilio TURN failed'
    }
  } else if (!extra.length && env.METERED_DOMAIN && env.METERED_API_KEY) {
    try {
      extra.push(...(await meteredIce(env.METERED_DOMAIN, env.METERED_API_KEY, fetchImpl)))
      turn = 'metered'
      turnError = undefined
    } catch (error) {
      turnError = error instanceof Error ? error.message : 'Metered TURN failed'
    }
  }

  if (!extra.length && !turnError) return { ...baseIceConfig(), iceTransportPolicy: policy }
  return withStun(extra, turn, turnError, policy)
}

async function cloudflareIce(keyId: string, token: string, fetchImpl: typeof fetch): Promise<IceServer[]> {
  const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: 3600 }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Cloudflare TURN ${response.status}`)
  const body = (await response.json()) as { iceServers?: IceServer[] | IceServer }
  const listed = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : []
  return listed.map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? server.urls : [server.urls],
  }))
}

async function twilioIce(sid: string, token: string, fetchImpl: typeof fetch): Promise<IceServer[]> {
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Twilio NTS ${response.status}`)
  const body = (await response.json()) as { ice_servers?: { urls?: string | string[]; url?: string; username?: string; credential?: string }[] }
  return (body.ice_servers || []).map((server) => ({
    urls: server.urls || server.url || '',
    username: server.username,
    credential: server.credential,
  }))
}

async function meteredIce(domain: string, apiKey: string, fetchImpl: typeof fetch): Promise<IceServer[]> {
  const host = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const response = await fetchImpl(`https://${host}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Metered TURN ${response.status}`)
  const body = (await response.json()) as IceServer[]
  return Array.isArray(body) ? body : []
}
