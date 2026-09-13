/**
 * Worker environment bindings (spec §5, §6).
 *
 * Secrets (GH_PRIVATE_KEY, GH_WEBHOOK_SECRET, GEMINI_API_KEY) are set via
 * Wrangler secrets in production and .dev.vars locally; they appear in Env
 * so code can read them, never in wrangler.jsonc vars.
 */
export type Env = {
  /** Numeric GitHub App id (var, not secret). Empty until app registration. */
  GH_APP_ID: string
  /** App private key PEM (secret). */
  GH_PRIVATE_KEY: string
  /** Webhook HMAC secret (secret). */
  GH_WEBHOOK_SECRET: string
  /** Google AI Studio key (secret). */
  GEMINI_API_KEY: string
  /** Delivery-id dedupe + installation token cache. */
  IDEMPOTENCY_KV: KVNamespace
  /** Async job producer (queue consumer wired in Phase 4). */
  REVIEW_QUEUE: Queue
}
