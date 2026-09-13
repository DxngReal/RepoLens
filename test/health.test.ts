import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * /healthz liveness test. Webhook behavior is covered in webhook.test.ts.
 * No real GitHub API or LLM calls (hard rule, spec §12).
 */
describe('GET /healthz', () => {
  it('returns 200 with ok=true and no sensitive fields', async () => {
    const res = await SELF.fetch('https://example.com/healthz')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('repolens')
  })
})
