import type { Env } from '../env'

/**
 * POST /webhook — Phase 1 stub (spec §5, Phase 1 milestone list).
 *
 * Always returns 200 without processing. Real behavior is added in Phase 2:
 *   1. Verify X-Hub-Signature-256 (401 on invalid)   — Phase 2
 *   2. Delivery-id dedupe via KV                     — Phase 2
 *   3. Enqueue job                                   — Phase 4
 *
 * Takes the raw Request so signature/delivery headers are available in
 * Phase 2, and Env so KV/Queue bindings can be used without refactoring.
 * Never logs or echoes payload contents (spec §7, §13).
 */
export async function handleWebhook(
  _request: Request,
  _env: Env,
): Promise<Response> {
  return new Response(null, { status: 200 })
}
