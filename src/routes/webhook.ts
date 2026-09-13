import { waitUntil } from 'cloudflare:workers'
import { runOnboardingJob } from '../analyze/onboarding'
import { runReviewJob } from '../analyze/review'
import type { Env } from '../env'
import { logSafe } from '../errors'
import { verifyWebhookSignature } from '../github/verify'
import { buildReviewProvider, type QueueMessage } from '../queue/consumer'

/**
 * POST /webhook (spec §5, §7, §13, §14):
 *
 *   1. Verify X-Hub-Signature-256 → 401 on missing/invalid (fail closed)
 *   2. Delivery-id dedupe via KV (duplicate → 200, skip)
 *   3. Mark delivery id (TTL 24h)
 *   4. Enqueue jobs, then 200:
 *      - installation.created → one onboarding_job per accessible repo
 *      - pull_request opened/synchronize → one review_job
 *
 * The webhook handler performs no GitHub/LLM calls before responding
 * (spec §14). Jobs go to REVIEW_QUEUE; when no queue binding is bound
 * (unit tests, minimal local dev), jobs run inline via `waitUntil` so
 * behavior is preserved. Logs are single safe lines: allow-listed words
 * only, never payload contents or header echoes (spec §7, §13).
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
      const repoEntry = entry as Record<string, unknown>
      if (
        typeof repoEntry.name !== 'string' ||
        typeof repoEntry.full_name !== 'string'
      ) {
        return []
      }
      const owner = repoEntry.full_name.includes('/')
        ? repoEntry.full_name.slice(0, repoEntry.full_name.indexOf('/'))
        : ''
      if (owner.length === 0) return []
      return [{ owner, repo: repoEntry.name }]
    })
  }
  return { action, installationId, repositories }
}

/** Extracts safe, allow-listed fields from a pull_request payload. */
function parsePullRequestPayload(rawBody: string): {
  action: string
  installationId: number | null
  number: number | null
  owner: string | null
  repo: string | null
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

  const pullRequest = record.pull_request
  const number =
    pullRequest !== null &&
    typeof pullRequest === 'object' &&
    typeof (pullRequest as Record<string, unknown>).number === 'number'
      ? ((pullRequest as Record<string, unknown>).number as number)
      : null

  let owner: string | null = null
  let repo: string | null = null
  const repository = record.repository
  if (repository !== null && typeof repository === 'object') {
    const repoRecord = repository as Record<string, unknown>
    if (typeof repoRecord.name === 'string') repo = repoRecord.name
    const ownerField = repoRecord.owner
    if (
      ownerField !== null &&
      typeof ownerField === 'object' &&
      typeof (ownerField as Record<string, unknown>).login === 'string'
    ) {
      owner = (ownerField as Record<string, unknown>).login as string
    }
  }
  return { action, installationId, number, owner, repo }
}

/** Injectables for tests: mock fetch, capture enqueues/background work. */
export type WebhookOptions = {
  fetchImpl?: typeof fetch
  waitUntilImpl?: (promise: Promise<unknown>) => void
  /** Captures/overrides queue sends when testing. */
  enqueueImpl?: (message: QueueMessage) => Promise<void>
}

/** Runs one job inline under waitUntil (no-queue fallback + tests). */
function executeInline(
  env: Env,
  message: QueueMessage,
  options: WebhookOptions,
  requestId: string,
): void {
  const schedule = options.waitUntilImpl ?? waitUntil
  const fetchImpl = options.fetchImpl ?? fetch
  const work =
    message.type === 'onboarding_job'
      ? runOnboardingJob(env, message, fetchImpl)
      : runReviewJob(env, message, {
          fetchImpl,
          provider: buildReviewProvider(env),
        })
  schedule(
    work
      .then((result) => {
        if (result.status === 'posted') {
          console.log(
            logSafe([
              requestId,
              'background job finished:',
              message.type,
              'posted',
            ]),
          )
        } else {
          console.log(
            logSafe([
              requestId,
              'background job finished:',
              message.type,
              'skipped',
              result.reason ?? 'unknown',
            ]),
          )
        }
      })
      .catch((error: unknown) => {
        // One safe line; error text could carry untrusted content
        // (spec §13), so only the typed name + status are logged.
        console.log(
          logSafe([
            requestId,
            'background job errored:',
            message.type,
            { error },
          ]),
        )
      }),
  )
}

/** Queue send with inline fallback when the binding is unavailable. */
function makeEnqueue(
  env: Env,
  options: WebhookOptions,
  requestId: string,
): (message: QueueMessage) => Promise<void> {
  if (options.enqueueImpl !== undefined) {
    return options.enqueueImpl
  }
  const queue = env.REVIEW_QUEUE
  if (queue !== undefined && typeof queue.send === 'function') {
    return async (message) => {
      try {
        await queue.send(message)
      } catch {
        // Queue unavailable → degrade to inline execution (spec §13).
        console.log(logSafe(['queue send failed: running job inline']))
        executeInline(env, message, options, requestId)
      }
    }
  }
  return async (message) => {
    executeInline(env, message, options, requestId)
  }
}

export async function handleWebhook(
  request: Request,
  env: Env,
  options: WebhookOptions = {},
): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const eventName = request.headers.get('x-github-event')
  // Request-id correlation (spec §13: hardened logging): only the UUID
  // delivery id is logged, never payload or header contents.
  const requestId = request.headers.get('x-github-delivery') ?? 'none'

  const valid = await verifyWebhookSignature(
    rawBody,
    signature,
    env.GH_WEBHOOK_SECRET,
  )
  if (!valid) {
    console.log(logSafe(['webhook rejected: invalid signature', requestId]))
    return new Response(null, { status: 401 })
  }

  const deliveryId = request.headers.get('x-github-delivery')
  if (!deliveryId) {
    console.log(logSafe(['webhook rejected: missing delivery id']))
    return new Response(null, { status: 400 })
  }

  // Idempotency (spec §5 steps 2-3): skip deliveries already processed.
  const dedupeKey = `delivery:${deliveryId}`
  const seen = await env.IDEMPOTENCY_KV.get(dedupeKey)
  if (seen !== null) {
    console.log(logSafe(['webhook skipped: duplicate delivery', requestId]))
    return new Response(null, { status: 200 })
  }
  await env.IDEMPOTENCY_KV.put(dedupeKey, '1', {
    expirationTtl: DELIVERY_TTL_SECONDS,
  })

  if (eventName === 'ping') {
    console.log(logSafe(['webhook accepted: ping', requestId]))
    return new Response(null, { status: 200 })
  }

  const enqueue = makeEnqueue(env, options, requestId)

  if (eventName === 'installation') {
    const payload = parseInstallationPayload(rawBody)
    if (payload === null) {
      console.log('webhook accepted: installation (unparseable payload)')
      return new Response(null, { status: 200 })
    }
    if (payload.action === 'created' && payload.installationId !== null) {
      const jobs: QueueMessage[] = payload.repositories.map(
        ({ owner, repo }) => ({
          type: 'onboarding_job',
          installationId: payload.installationId as number,
          owner,
          repo,
        }),
      )
      console.log(
        logSafe([
          'webhook accepted: installation created',
          jobs.length,
          'repo(s)',
          requestId,
        ]),
      )
      for (const job of jobs) {
        await enqueue(job)
      }
    } else if (payload.action === 'deleted') {
      console.log('webhook accepted: installation deleted')
    } else {
      console.log('webhook accepted: installation (unhandled action)')
    }
    return new Response(null, { status: 200 })
  }

  if (eventName === 'pull_request') {
    const payload = parsePullRequestPayload(rawBody)
    if (
      payload !== null &&
      (payload.action === 'opened' || payload.action === 'synchronize') &&
      payload.installationId !== null &&
      payload.number !== null &&
      payload.owner !== null &&
      payload.repo !== null
    ) {
      console.log(
        logSafe(['webhook accepted: pull_request', payload.action, requestId]),
      )
      await enqueue({
        type: 'review_job',
        installationId: payload.installationId,
        owner: payload.owner,
        repo: payload.repo,
        number: payload.number,
      })
    } else {
      console.log('webhook accepted: pull_request (ignored action)')
    }
    return new Response(null, { status: 200 })
  }

  console.log('webhook accepted: ignored event')
  return new Response(null, { status: 200 })
}
