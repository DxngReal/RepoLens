import type { Env } from '../env'
import { verifyWebhookSignature } from '../github/verify'

/**
 * POST /webhook — Phase 2 behavior (spec §5, §7):
 *
 *   1. Verify X-Hub-Signature-256 → 401 on missing/invalid (fail closed)
 *   2. Delivery-id dedupe via KV (duplicate → 200, skip)
 *   3. Mark delivery id (TTL 24h)
 *   4. Route: ping → 200; installation created/deleted → accepted (the
 *      onboarding job is wired in Phase 3); unknown events → 200 ignored.
 *
 * Enqueueing to the queue lands in Phase 4 together with the consumer.
 * Logs are single safe lines: no payload contents, no header echoes
 * (spec §7, §13). Untrusted header/payload strings are never logged
 * verbatim.
 */

const DELIVERY_TTL_SECONDS = 24 * 60 * 60

export async function handleWebhook(
  request: Request,
  env: Env,
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
    // Action is allow-listed before logging; payload is never echoed.
    let action: string | undefined
    try {
      const parsed = JSON.parse(rawBody) as { action?: unknown }
      action = typeof parsed.action === 'string' ? parsed.action : 'unparseable'
    } catch {
      action = 'unparseable'
    }
    if (action === 'created' || action === 'deleted') {
      console.log(`webhook accepted: installation ${action}`)
    } else {
      console.log('webhook accepted: installation (unhandled action)')
    }
    // Phase 3 wires the onboarding job here.
    return new Response(null, { status: 200 })
  }

  console.log('webhook accepted: ignored event')
  return new Response(null, { status: 200 })
}
