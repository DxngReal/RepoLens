import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * Workers-native test runner (spec §4, §12).
 *
 * Tests run inside workerd with local miniflare bindings; no real GitHub
 * API or LLM calls, ever (hard rule).
 *
 * Note: `@cloudflare/vitest-pool-workers` was renamed/upgraded to
 * `@cloudflare/vitest-plugin` (Vitest 4+ API, `cloudflareTest()` plugin).
 * See docs/design-decisions.md.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        kvNamespaces: ['IDEMPOTENCY_KV'],
        queueProducers: ['REVIEW_QUEUE'],
      },
    }),
  ],
})
