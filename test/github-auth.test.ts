import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import {
  createAppJwt,
  getInstallationToken,
  pemToPkcs8Der,
} from '../src/github/auth'
import { verifyWebhookSignature } from '../src/github/verify'

/**
 * Phase 2 tests (spec §12): HMAC verification, JWT/installation auth.
 * All fetch calls are mocked; keys are generated in-test. No real GitHub
 * API calls (hard rule).
 */

const TEST_SECRET = 'test-webhook-secret'

async function signedPayload(
  payload: string,
  secret = TEST_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  let hex = ''
  for (const byte of new Uint8Array(mac)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return `sha256=${hex}`
}

/** Env stub over the real local bindings with test credential values. */
function envWithPrivateKey(privateKeyPem: string): Env {
  return {
    ...(env as object),
    GH_APP_ID: '12345',
    GH_PRIVATE_KEY: privateKeyPem,
    GH_WEBHOOK_SECRET: 'test-webhook-secret',
  } as unknown as Env
}

/** Local KV binding, typed via our Env (runtime object is the same). */
const kv = (env as unknown as Env).IDEMPOTENCY_KV

/** Generates a fresh 2048-bit RSA keypair and exports PKCS#8 PEM. */
async function generateTestPrivateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign'],
  )) as CryptoKeyPair
  const der = (await crypto.subtle.exportKey(
    'pkcs8',
    pair.privateKey,
  )) as ArrayBuffer
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)))
  const lines = base64.match(/.{1,64}/g)?.join('\n') ?? base64
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid sha256 signature', async () => {
    const payload = JSON.stringify({ zen: 'Keep it logically awesome.' })
    const signature = await signedPayload(payload)
    await expect(
      verifyWebhookSignature(payload, signature, TEST_SECRET),
    ).resolves.toBe(true)
  })

  it('rejects an invalid signature', async () => {
    const payload = '{"zen":"x"}'
    const signature = await signedPayload('{"zen":"different"}')
    await expect(
      verifyWebhookSignature(payload, signature, TEST_SECRET),
    ).resolves.toBe(false)
  })

  it('rejects a signature computed with the wrong secret', async () => {
    const payload = '{"zen":"x"}'
    const signature = await signedPayload(payload, 'attacker-secret')
    await expect(
      verifyWebhookSignature(payload, signature, TEST_SECRET),
    ).resolves.toBe(false)
  })

  it('rejects a missing signature header (fail closed)', async () => {
    await expect(verifyWebhookSignature('{}', null, TEST_SECRET)).resolves.toBe(
      false,
    )
    await expect(verifyWebhookSignature('{}', '', TEST_SECRET)).resolves.toBe(
      false,
    )
  })

  it('rejects when no secret is configured (fail closed)', async () => {
    const payload = '{}'
    const signature = await signedPayload(payload)
    await expect(
      verifyWebhookSignature(payload, signature, undefined),
    ).resolves.toBe(false)
  })

  it('rejects malformed signature headers', async () => {
    const payload = '{}'
    await expect(
      verifyWebhookSignature(payload, 'sha1=deadbeef', TEST_SECRET),
    ).resolves.toBe(false)
    await expect(
      verifyWebhookSignature(payload, 'sha256=not-hex', TEST_SECRET),
    ).resolves.toBe(false)
    await expect(
      verifyWebhookSignature(payload, `sha256=${'0'.repeat(63)}`, TEST_SECRET),
    ).resolves.toBe(false)
  })
})

describe('pemToPkcs8Der', () => {
  it('parses a standard PEM body', async () => {
    const pem = await generateTestPrivateKeyPem()
    const der = pemToPkcs8Der(pem)
    expect(der.byteLength).toBeGreaterThan(1000)
  })

  it('parses a PEM containing escaped newlines (\\n literals)', async () => {
    const pem = await generateTestPrivateKeyPem()
    const escaped = pem.replaceAll('\n', '\\n')
    const der = pemToPkcs8Der(escaped)
    expect(der.byteLength).toBeGreaterThan(1000)
  })

  it('throws on an empty PEM body', () => {
    expect(() =>
      pemToPkcs8Der('-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----'),
    ).toThrow()
  })
})

describe('createAppJwt', () => {
  it('produces a three-part RS256 JWT with correct claims', async () => {
    const pem = await generateTestPrivateKeyPem()
    const now = 1_700_000_000_000
    const jwt = await createAppJwt('12345', pem, now)

    const [headerB64, payloadB64, signatureB64] = jwt.split('.')
    expect(headerB64).toBeTruthy()
    expect(payloadB64).toBeTruthy()
    expect(signatureB64).toBeTruthy()

    const header = JSON.parse(
      atob(headerB64.replaceAll('-', '+').replaceAll('_', '/')),
    )
    expect(header.alg).toBe('RS256')
    expect(header.typ).toBe('JWT')

    const claims = JSON.parse(
      atob(payloadB64.replaceAll('-', '+').replaceAll('_', '/')),
    )
    expect(claims.iss).toBe('12345')
    // iat backdated 60s, exp = iat + 600s (10 minutes, GitHub cap)
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60)
    expect(claims.exp).toBe(claims.iat + 600)
  })

  it('signs a JWT that verifies against the matching public key', async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const der = (await crypto.subtle.exportKey(
      'pkcs8',
      pair.privateKey,
    )) as ArrayBuffer
    const base64 = btoa(String.fromCharCode(...new Uint8Array(der)))
    const pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`

    const jwt = await createAppJwt('999', pem)
    const [headerB64, payloadB64, signatureB64] = jwt.split('.')
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const signatureBytes = Uint8Array.from(
      atob(signatureB64.replaceAll('-', '+').replaceAll('_', '/')),
      (c) => c.charCodeAt(0),
    )
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.publicKey,
      signatureBytes,
      signingInput,
    )
    expect(ok).toBe(true)
  })
})

describe('getInstallationToken', () => {
  it('fetches a token from GitHub and caches it in KV', async () => {
    const pem = await generateTestPrivateKeyPem()
    const testEnvObj = envWithPrivateKey(pem)

    const calls: string[] = []
    const fetchMock = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(
        JSON.stringify({
          token: 'ghs_testtoken',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { contents: 'read' },
        }),
        { status: 201 },
      )
    }) as typeof fetch

    const token = await getInstallationToken(testEnvObj, 42, fetchMock)
    expect(token).toBe('ghs_testtoken')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/app/installations/42/access_tokens')

    const cached = await kv.get<{ token: string }>('install-token:42', 'json')
    expect(cached?.token).toBe('ghs_testtoken')
  })

  it('returns the cached token without calling GitHub while fresh', async () => {
    const testEnvObj = envWithPrivateKey(await generateTestPrivateKeyPem())

    await kv.put(
      'install-token:7',
      JSON.stringify({
        token: 'ghs_cached',
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      }),
    )

    let calls = 0
    const fetchMock = (async () => {
      calls++
      return new Response('{}', { status: 201 })
    }) as typeof fetch

    const token = await getInstallationToken(testEnvObj, 7, fetchMock)
    expect(token).toBe('ghs_cached')
    expect(calls).toBe(0)
  })

  it('refetches when the cached token is near expiry', async () => {
    const testEnvObj = envWithPrivateKey(await generateTestPrivateKeyPem())

    // Expires in 30s — inside the 60s refresh margin.
    await kv.put(
      'install-token:8',
      JSON.stringify({
        token: 'ghs_stale',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    )

    let calls = 0
    const fetchMock = (async () => {
      calls++
      return new Response(
        JSON.stringify({
          token: 'ghs_fresh',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      )
    }) as typeof fetch

    const token = await getInstallationToken(testEnvObj, 8, fetchMock)
    expect(token).toBe('ghs_fresh')
    expect(calls).toBe(1)
  })

  it('throws with status only (no response body in the error) on API failure', async () => {
    const testEnvObj = envWithPrivateKey(await generateTestPrivateKeyPem())

    const fetchMock = (async () =>
      new Response('{"message":"Bad credentials"}', {
        status: 401,
      })) as typeof fetch

    await expect(
      getInstallationToken(testEnvObj, 9, fetchMock),
    ).rejects.toThrow(/status 401$/)
  })
})
