import { waitUntil } from 'cloudflare:workers'
import { runOnboardingJob } from '../analyze/onboarding'
import type { Env } from '../env'
import { verifyWebhookSignature } from '../github/verify'

/**
 * POST /webhook (spec §5, §7, §13):
 *
 *   1. Verify X-Hub-Signature-256 → 401 on missing/invalid (fail closed)
 *   2. Delivery-id dedupe via KV (duplicate → 200, skip)
 *   3. Mark delivery id (TTL 24h)
 *   4. Route: ping → 200; installation created → onboarding jobs run in
 *      the background (inline waitUntil until the Phase 4 queue);
 *      installation deleted → 200; unknown events → 200 ignored.
 *
 * The webhook handler performs no GitHub/LLM calls before responding
 * (spec §14) — background work is scheduled via `waitUntil` after the
 * response is prepared. Logs are single safe lines: allow-listed action
 * words only, never payload contents or header echoes (spec §7, §13).
 * Onboarding failures log one safe line and never affect the response.
 */

const DELIVERY_TTL_SECONDS = 24 * 60 * 60

/** Extracts safe, allow-listed fields from an installation payload. */
function parseInstallationPayload(rawBody: string): {
  action: string
  installationId: number | null
  repositories: { owner: string; repo: string }[]
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const action = typeof record.action === 'string' ? record.action : ''
  const installation = record.installation
  const installationId =
    installation !== null &&
    typeof installation === 'object' &&
    typeof (installation as Record<string, unknown>).id === 'number'
      ? ((installation as Record<string, unknown>).id as number)
      : null

  let repositories: { owner: string; repo: string }[] = []
  const reposRaw = record.repositories
  if (Array.isArray(reposRaw)) {
    repositories = reposRaw.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object') return []
      const repo = entry as Record<string, unknown>
      if (typeof repo.name !== 'string' || typeof repo.full_name !== 'string') {
        return []
      }
      const owner = repo.full_name.includes('/')
        ? repo.full_name.slice(0, repo.full_name.indexOf('/'))
        : ''
      if (owner.length === 0) return []
      return [{ owner, repo: repo.name }]
    })
  }
  return { action, installationId, repositories }
}

/** Injectables for tests: mock fetch and capture background work. */
export type WebhookOptions = {
  fetchImpl?: typeof fetch
  waitUntilImpl?: (promise: Promise<unknown>) => void
}

export async function handleWebhook(
  request: Request,
  env: Env,
  options: WebhookOptions = {},
): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const eventName = request.headers.get('x-github-event')

  const valid = await verifyWebhookSignature(
    rawBody,
    signature,
    env.GH_WEBHOOK_SECRET,
  )
  if (!valid) {
    console.log('webhook rejected: invalid signature')
    return new Response(null, { status: 401 })
  }

  const deliveryId = request.headers.get('x-github-delivery')
  if (!deliveryId) {
    console.log('webhook rejected: missing delivery id')
    return new Response(null, { status: 400 })
  }

  // Idempotency (spec §5 step 2-3): skip deliveries already processed.
  const dedupeKey = `delivery:${deliveryId}`
  const seen = await env.IDEMPOTENCY_KV.get(dedupeKey)
  if (seen !== null) {
    console.log('webhook skipped: duplicate delivery')
    return new Response(null, { status: 200 })
  }
  await env.IDEMPOTENCY_KV.put(dedupeKey, '1', {
    expirationTtl: DELIVERY_TTL_SECONDS,
  })

  if (eventName === 'ping') {
    console.log('webhook accepted: ping')
    return new Response(null, { status: 200 })
  }

  if (eventName === 'installation') {
    const payload = parseInstallationPayload(rawBody)
    if (payload === null) {
      console.log('webhook accepted: installation (unparseable payload)')
      return new Response(null, { status: 200 })
    }
    if (payload.action === 'created' && payload.installationId !== null) {
      const fetchImpl = options.fetchImpl ?? fetch
      const schedule = options.waitUntilImpl ?? waitUntil
      const jobs = payload.repositories.map(({ owner, repo }) => ({
        installationId: payload.installationId as number,
        owner,
        repo,
      }))
      console.log(
        `webhook accepted: installation created (${jobs.length} repo${jobs.length === 1 ? '' : 's'})`,
      )
      for (const job of jobs) {
        schedule(
          runOnboardingJob(env, job, fetchImpl).catch(() => {
            // One safe line; error text could carry untrusted content
            // (spec §13), so details stay out of the log.
            console.log('onboarding failed: background job errored')
          }),
        )
      }
    } else if (payload.action === 'deleted') {
      console.log('webhook accepted: installation deleted')
    } else {
      console.log('webhook accepted: installation (unhandled action)')
    }
    return new Response(null, { status: 200 })
  }

  console.log('webhook accepted: ignored event')
  return new Response(null, { status: 200 })
}
