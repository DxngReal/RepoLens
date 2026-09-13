import { Hono } from 'hono'
import type { Env } from './env'
import queueConsumer from './queue/consumer'
import { health } from './routes/health'
import { handleWebhook } from './routes/webhook'

/**
 * RepoLens Worker entrypoint (spec §5).
 *
 * Request flow (Phase 4):
 *   GitHub webhook → POST /webhook → verify HMAC → dedupe → enqueue → 200
 *   Queue consumer → onboarding/review jobs (GitHub + LLM calls here)
 */
const app = new Hono<{ Bindings: Env }>()

app.route('/', health)

app.post('/webhook', (c) => handleWebhook(c.req.raw, c.env))

export default {
  fetch: app.fetch,
  queue: queueConsumer.queue,
} satisfies ExportedHandler<Env>
