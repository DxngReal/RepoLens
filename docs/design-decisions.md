# RepoLens — Design Decisions

Fixed decisions from `docs/MASTER_BUILD_PROMPT.md` §4, plus the reasoning
behind each new dependency.

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers | Serverless, generous free tier ($0/month target) |
| Router | Hono | Lightweight, first-class Workers support |
| GitHub SDK | Octokit (`@octokit/app`, `@octokit/webhooks`) directly | Probot is aging; direct Octokit teaches the real mechanics |
| Async | Cloudflare Queues | Webhooks must ack fast; AI work is slow |
| State | Cloudflare KV | Delivery-id dedupe, installation token cache |
| LLM | Gemini Flash via REST | Free tier, one provider only in v0.1.0 |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Workers-native testing |
| Lint/format | Biome | One fast tool for lint + format |
| Types | `tsc --noEmit` (strict) | Baseline safety |
| Local webhooks | smee.io | Forwards GitHub events to localhost |

## Dependencies

Every dependency gets a one-line justification (spec §4):

- `hono` — HTTP router with native Workers support (no Node polyfills needed).
- `@octokit/app`, `@octokit/webhooks`, `octokit` — GitHub App auth (JWT →
  installation tokens) and webhook primitives without the Probot runtime.
- `wrangler` — Cloudflare dev/deploy toolchain.
- `@cloudflare/vitest-pool-workers` + `@cloudflare/workers-types` — run
  tests inside workerd against real bindings semantics.
- `vitest` — test runner required by the workers pool.
- `typescript` — strict type checking (`tsc --noEmit`).
- `@biomejs/biome` — lint + format in one fast tool.

## Deliberate exclusions

- No Probot (runtime age/maintenance concerns per spec).
- No databases, Redis, or vector stores — KV covers dedupe + cache.
- No additional LLM providers — `LLMProvider` interface keeps one adapter.
- No issue triage, Q&A, dashboards, or realtime — honest v0.1.0 scope.

## Notes

- `wrangler.jsonc` KV namespace id is a local placeholder until the real
  namespace is created in Phase 6; tests use local miniflare bindings.
- Queue consumer wiring lands in Phase 4 with `src/queue/consumer.ts`.
