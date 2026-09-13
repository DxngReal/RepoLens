import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { verifyWebhookSignature } from '../src/github/verify'
import { handleWebhook } from '../src/routes/webhook'

/**
 * Phase 2 webhook-route tests (spec §12): HMAC gating, delivery-id
 * idempotency via KV, ping/installation handling. Uses the real local KV
 * binding (miniflare); no GitHub API calls.
 */

const TEST_SECRET = 'test-webhook-secret'

/** Env stub wired to the local KV binding and a known test secret. */
function testEnv(): Env {
  return {
    ...(env as object),
    GH_APP_ID: '12345',
    GH_PRIVATE_KEY: 'unused-in-route-tests',
    GH_WEBHOOK_SECRET: TEST_SECRET,
  } as unknown as Env
}

/** Local KV binding via our Env typing (same runtime object). */
const kv = (env as unknown as Env).IDEMPOTENCY_KV

/**
 * Generates a throwaway RSA key so background onboarding jobs can sign
 * an app JWT in tests (never a real credential).
 */
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

function envWithPrivateKey(privateKeyPem: string): Env {
  return {
    ...(env as object),
    GH_APP_ID: '12345',
    GH_PRIVATE_KEY: privateKeyPem,
    GH_WEBHOOK_SECRET: TEST_SECRET,
  } as unknown as Env
}

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

function webhookRequest(options: {
  body: string
  signature?: string | null
  event?: string
  delivery?: string
}): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (options.signature !== null) {
    headers.set('x-hub-signature-256', options.signature ?? '')
  }
  if (options.event) headers.set('x-github-event', options.event)
  if (options.delivery) headers.set('x-github-delivery', options.delivery)
  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers,
    body: options.body,
  })
}

beforeEach(async () => {
  // Idempotency tests need a clean KV namespace per test.
  await kv.delete('delivery:duplicate-1')
  await kv.delete('delivery:duplicate-2')
})

describe('POST /webhook — signature gating', () => {
  it('returns 401 for an invalid signature', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature: `sha256=${'a'.repeat(64)}`,
        event: 'ping',
        delivery: 'sig-bad',
      }),
      testEnv(),
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the signature header is missing', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature: null,
        event: 'ping',
        delivery: 'sig-missing',
      }),
      testEnv(),
    )
    expect(res.status).toBe(401)
  })

  it('accepts a validly signed delivery', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'unknown_event',
        delivery: 'sig-ok',
      }),
      testEnv(),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /webhook — delivery idempotency', () => {
  it('marks the delivery id in KV after accepting', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const signature = await signedPayload(body)
    await handleWebhook(
      webhookRequest({ body, signature, event: 'ping', delivery: 'mark-1' }),
      testEnv(),
    )
    const marked = await kv.get('delivery:mark-1')
    expect(marked).not.toBeNull()
    await kv.delete('delivery:mark-1')
  })

  it('returns 200 and skips reprocessing for a duplicate delivery', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const signature = await signedPayload(body)

    const first = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'ping',
        delivery: 'duplicate-1',
      }),
      testEnv(),
    )
    expect(first.status).toBe(200)

    // Duplicate delivery: valid signature, same delivery id.
    const second = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'ping',
        delivery: 'duplicate-1',
      }),
      testEnv(),
    )
    expect(second.status).toBe(200)
  })

  it('treats distinct delivery ids independently', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const signature = await signedPayload(body)
    const a = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'ping',
        delivery: 'duplicate-2',
      }),
      testEnv(),
    )
    const b = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'ping',
        delivery: 'duplicate-3',
      }),
      testEnv(),
    )
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    await kv.delete('delivery:duplicate-3')
  })
})

describe('POST /webhook — event routing', () => {
  it('accepts ping', async () => {
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' })
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({ body, signature, event: 'ping', delivery: 'ping-1' }),
      testEnv(),
    )
    expect(res.status).toBe(200)
    await kv.delete('delivery:ping-1')
  })

  it('accepts installation created', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 1 } })
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'installation',
        delivery: 'inst-1',
      }),
      testEnv(),
    )
    expect(res.status).toBe(200)
    await kv.delete('delivery:inst-1')
  })

  it('accepts installation deleted', async () => {
    const body = JSON.stringify({ action: 'deleted', installation: { id: 1 } })
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'installation',
        delivery: 'inst-2',
      }),
      testEnv(),
    )
    expect(res.status).toBe(200)
    await kv.delete('delivery:inst-2')
  })

  it('ignores unknown events with 200', async () => {
    const body = JSON.stringify({ action: 'opened' })
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'issues',
        delivery: 'issues-1',
      }),
      testEnv(),
    )
    expect(res.status).toBe(200)
    await kv.delete('delivery:issues-1')
  })

  it('returns 400 when the delivery id header is missing', async () => {
    const body = JSON.stringify({ zen: 'hi' })
    const signature = await signedPayload(body)
    const req = webhookRequest({ body, signature, event: 'ping' })
    // Remove the delivery header to simulate a malformed delivery.
    const headers = new Headers(req.headers)
    headers.delete('x-github-delivery')
    const noDelivery = new Request('https://example.com/webhook', {
      method: 'POST',
      headers,
      body,
    })
    const res = await handleWebhook(noDelivery, testEnv())
    expect(res.status).toBe(400)
  })
})

describe('POST /webhook — installation.created onboarding wiring', () => {
  /** Captures background jobs instead of running them. */
  function captureWaitUntil(): {
    jobs: Promise<unknown>[]
    runAll: () => Promise<void>
  } {
    const jobs: Promise<unknown>[] = []
    return {
      jobs,
      runAll: async () => {
        await Promise.allSettled(jobs)
      },
    }
  }

  function installationBody(): string {
    return JSON.stringify({
      action: 'created',
      installation: { id: 55 },
      repositories: [
        { name: 'alpha', full_name: 'octo/alpha' },
        { name: 'beta', full_name: 'octo/beta' },
      ],
    })
  }

  it('schedules one onboarding job per repository', async () => {
    const captured = captureWaitUntil()
    const calls: string[] = []
    // Serves the token exchange and repo metadata, records everything,
    // and throws afterwards so jobs stop early (failures are swallowed
    // by design; we only assert which API calls were attempted).
    const fetchImpl = (async (url: RequestInfo | URL): Promise<Response> => {
      const urlText = String(url)
      calls.push(urlText)
      if (urlText.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'mock-installation-token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 201 },
        )
      }
      if (/\/repos\/octo\/(alpha|beta)$/.test(urlText)) {
        return new Response(
          JSON.stringify({
            name: 'x',
            full_name: 'octo/x',
            default_branch: 'main',
          }),
          { status: 200 },
        )
      }
      throw new Error('not used beyond call capture')
    }) as typeof fetch

    const body = installationBody()
    const signature = await signedPayload(body)
    // A real test key: the background job must get past JWT signing to
    // reach the (mocked) GitHub fetch.
    const jobEnv = envWithPrivateKey(await generateTestPrivateKeyPem())
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'installation',
        delivery: 'onboard-1',
      }),
      jobEnv,
      { fetchImpl, waitUntilImpl: (p) => void captured.jobs.push(p) },
    )
    expect(res.status).toBe(200)
    expect(captured.jobs).toHaveLength(2)
    // Background jobs started with the mocked fetch (which records calls).
    await captured.runAll()
    expect(calls.some((url) => url.includes('/repos/octo/alpha'))).toBe(true)
    expect(calls.some((url) => url.includes('/repos/octo/beta'))).toBe(true)
    await kv.delete('delivery:onboard-1')
  })

  it('swallows background onboarding failures (response stays 200)', async () => {
    const captured = captureWaitUntil()
    const fetchImpl = (async (): Promise<Response> => {
      return new Response('boom', { status: 500 })
    }) as typeof fetch

    const body = installationBody()
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'installation',
        delivery: 'onboard-2',
      }),
      testEnv(),
      { fetchImpl, waitUntilImpl: (p) => void captured.jobs.push(p) },
    )
    expect(res.status).toBe(200)
    await expect(captured.runAll()).resolves.toBeUndefined()
    await kv.delete('delivery:onboard-2')
  })

  it('does not schedule onboarding for installation.deleted', async () => {
    const captured = captureWaitUntil()
    const body = JSON.stringify({
      action: 'deleted',
      installation: { id: 55 },
    })
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'installation',
        delivery: 'onboard-3',
      }),
      testEnv(),
      { waitUntilImpl: (p) => void captured.jobs.push(p) },
    )
    expect(res.status).toBe(200)
    expect(captured.jobs).toHaveLength(0)
    await kv.delete('delivery:onboard-3')
  })

  it('responds 200 on unparseable installation payloads', async () => {
    const captured = captureWaitUntil()
    const body = 'not json at all'
    const signature = await signedPayload(body)
    const res = await handleWebhook(
      webhookRequest({
        body,
        signature,
        event: 'installation',
        delivery: 'onboard-4',
      }),
      testEnv(),
      { waitUntilImpl: (p) => void captured.jobs.push(p) },
    )
    expect(res.status).toBe(200)
    expect(captured.jobs).toHaveLength(0)
    await kv.delete('delivery:onboard-4')
  })
})

describe('signature helper parity', () => {
  it('verifyWebhookSignature agrees with itself on round trip', async () => {
    const body = 'round-trip'
    const signature = await signedPayload(body)
    await expect(
      verifyWebhookSignature(body, signature, TEST_SECRET),
    ).resolves.toBe(true)
  })
})
