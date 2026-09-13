/**
 * GitHub App authentication (spec §3, §6): JWT (RS256) signing and
 * installation access tokens with KV caching.
 *
 * - `createAppJwt` signs a 10-minute app JWT with WebCrypto (RSASSA-PKCS1-v1_5)
 *   so it works inside Workers without Node crypto.
 * - `getInstallationToken` exchanges the JWT for a short-lived installation
 *   token and caches it in KV until ~60s before expiry (spec §14: KV TTL =
 *   token lifetime).
 *
 * Secrets are read from Worker env only; tokens are never logged.
 * `fetchImpl` is injectable so tests use a mock (no real GitHub API calls,
 * hard rule).
 */

import type { Env } from '../env'
import { GitHubError } from '../errors'
import { fetchWithRetry } from '../util/retry'

const GH_API_BASE = 'https://api.github.com'
const USER_AGENT = 'repolens'
const API_VERSION = '2022-11-28'

/**
 * Non-retryable auth failures; message has status only (spec §13 —
 * response bodies can echo token material).
 */
export class GitHubAuthError extends GitHubError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'GitHubAuthError'
  }
}

/** Clock-skew guard applied to the JWT `iat` claim, in seconds. */
const JWT_IAT_BACKDATE_SECONDS = 60
/** GitHub caps app JWT lifetime at 10 minutes. */
const JWT_LIFETIME_SECONDS = 600
/** Refresh cached installation tokens this many seconds before expiry. */
const TOKEN_REFRESH_MARGIN_SECONDS = 60

/* ---------- base64url helpers ---------- */

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/* ---------- PEM → PKCS#8 DER ---------- */

/**
 * Extracts the DER body of a PKCS#8 PEM. Tolerates literal `\n` sequences
 * (how PEMs arrive when pasted into some secret stores) and whitespace.
 */
export function pemToPkcs8Der(pem: string): Uint8Array {
  const normalized = pem.replaceAll('\\n', '\n').trim()
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  if (body.length === 0) {
    throw new Error('malformed private key PEM')
  }
  return base64ToBytes(body)
}

/* ---------- app JWT ---------- */

export async function createAppJwt(
  appId: string,
  privateKey: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const der = pemToPkcs8Der(privateKey)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const nowSeconds = Math.floor(nowMs / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: nowSeconds - JWT_IAT_BACKDATE_SECONDS,
    exp: nowSeconds - JWT_IAT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS,
    iss: appId,
  }
  const signingInput = `${toBase64Url(new TextEncoder().encode(JSON.stringify(header)))}.${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
}

/* ---------- installation tokens ---------- */

type CachedToken = { token: string; expiresAt: string }

export async function getInstallationToken(
  env: Env,
  installationId: number | string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = `install-token:${installationId}`

  const cached = await env.IDEMPOTENCY_KV.get<CachedToken>(cacheKey, 'json')
  const expiresAtMs = cached ? Date.parse(cached.expiresAt) : Number.NaN
  if (
    cached &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs - TOKEN_REFRESH_MARGIN_SECONDS * 1000 > Date.now()
  ) {
    return cached.token
  }

  const jwt = await createAppJwt(env.GH_APP_ID, env.GH_PRIVATE_KEY)
  const response = await fetchWithRetry(
    fetchImpl,
    `${GH_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
    },
  )
  if (!response.ok) {
    // Status only — never the body (could echo token material, spec §13).
    throw new GitHubAuthError(
      response.status,
      `installation token request failed with status ${response.status}`,
    )
  }
  const data = (await response.json()) as {
    token?: string
    expires_at?: string
  }
  if (!data.token || !data.expires_at) {
    throw new Error('installation token response missing required fields')
  }

  const ttlSeconds = Math.max(
    60,
    Math.floor((Date.parse(data.expires_at) - Date.now()) / 1000),
  )
  await env.IDEMPOTENCY_KV.put(
    cacheKey,
    JSON.stringify({ token: data.token, expiresAt: data.expires_at }),
    { expirationTtl: ttlSeconds },
  )
  return data.token
}
