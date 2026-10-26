const BASE = 'https://rtc.live.cloudflare.com/v1'

export function sfuConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_SECRET)
}

export interface SfuResult {
  ok: boolean
  status: number
  body: unknown
}

/**
 * Proxy one Connection API call. The app id and secret stay on the server.
 * A lost response is not retried here: the client replaces the connection once.
 */
export async function sfuCall(
  env: NodeJS.ProcessEnv,
  path: string,
  method: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SfuResult> {
  const appId = env.CF_REALTIME_APP_ID || ''
  const secret = env.CF_REALTIME_APP_SECRET || ''
  if (!appId || !secret) return { ok: false, status: 403, body: { error: 'Cloudflare Realtime is not configured.', code: 'disabled' } }
  let response: Response
  try {
    response = await fetchImpl(`${BASE}/apps/${encodeURIComponent(appId)}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch {
    return { ok: false, status: 502, body: { error: 'The media server did not answer.', code: 'unreachable' } }
  }
  const text = await response.text()
  const redacted = secret ? text.split(secret).join('[redacted]') : text
  let parsed: unknown = null
  if (redacted) {
    try {
      parsed = JSON.parse(redacted)
    } catch {
      parsed = { error: 'The media server sent an unreadable response.', code: 'bad-response' }
    }
  }
  return { ok: response.ok, status: response.status, body: parsed }
}
