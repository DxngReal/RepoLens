import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { handleWebhook } from '../src/routes/webhook'

/**
 * Phase 1 smoke tests: /healthz liveness and the /webhook stub.
 * No real GitHub API or LLM calls (hard rule, spec §12).
 */

/** Stub env: the Phase 1 webhook stub reads no bindings. */
const env = {} as unknown as Env

describe('GET /healthz', () => {
  it('returns 200 with ok=true and no sensitive fields', async () => {
    const res = await SELF.fetch('https://example.com/healthz')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('repolens')
  })
})

describe('POST /webhook (Phase 1 stub)', () => {
  it('returns 200 for any POST without processing', async () => {
    const res = await SELF.fetch('https://example.com/webhook', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })

    expect(res.status).toBe(200)
  })

  it('handleWebhook returns a bare 200 Response', async () => {
    const res = await handleWebhook(
      new Request('https://example.com/webhook', { method: 'POST' }),
      env,
    )
    expect(res.status).toBe(200)
  })
})
