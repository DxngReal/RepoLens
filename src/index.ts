import { Hono } from 'hono'
import type { Env } from './env'
import { health } from './routes/health'
import { handleWebhook } from './routes/webhook'

/**
 * RepoLens Worker entrypoint (spec §5).
 *
 * Request flow target (built up across phases):
 *   GitHub webhook → POST /webhook → verify HMAC → dedupe → enqueue → 200
 */
const app = new Hono<{ Bindings: Env }>()

app.route('/', health)

app.post('/webhook', (c) => handleWebhook(c.req.raw, c.env))

export default app satisfies ExportedHandler<Env>
