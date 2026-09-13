# RepoLens — Architecture

Event-driven GitHub App on Cloudflare Workers. Deterministic analysis
first; LLM summaries are an optional layer on top.

## Request flow

```text
GitHub webhook → POST /webhook
  1. Verify X-Hub-Signature-256 (reject invalid with 401)   [Phase 2]
  2. Check delivery id in KV (duplicate → 200, skip)        [Phase 2]
  3. Mark delivery id in KV (TTL ~24h)                      [Phase 2]
  4. Enqueue job { event type, payload subset }             [Phase 4]
  5. Return 200 immediately

Queue consumer → job handler                                 [Phase 3–4]
  onboarding_job → fetch repo tree + manifests → deterministic report
                 → optional LLM summary → open issue
  review_job     → fetch PR diff → filter/budget → LLM summary
                 → post ONE review comment
```

## Module map

| Module | Responsibility |
|---|---|
| `src/index.ts` | Hono app + Workers fetch handler |
| `src/env.ts` | Bindings: vars, secrets, KV, Queue |
| `src/routes/webhook.ts` | Verify → dedupe → enqueue → 200 |
| `src/github/auth.ts` | App JWT signing, installation token cache |
| `src/github/verify.ts` | X-Hub-Signature-256 verification |
| `src/analyze/*` | Manifests, onboarding report, diff budgets |
| `src/llm/*` | LLMProvider interface, Gemini adapter, prompts |
| `src/queue/consumer.ts` | onboarding_job / review_job handlers |
| `src/config/repolens-yml.ts` | `.repolens.yml` parse + validate + defaults |

## Key invariants

- Webhook handler performs no GitHub/LLM calls before responding.
- All repository content is untrusted data: diff and file text is
  delimited in prompts and never executed as instructions.
- Exactly one PR review comment per delivery; duplicate delivery ids are
  skipped via KV (TTL ~24h).
- Secrets exist only as Wrangler secrets / Worker env — never in code,
  git, logs, or bot comments.

## Status

Phase 1 (Foundation) implements: Hono app, `/healthz`, `/webhook` stub,
wrangler config with KV + Queue bindings, Vitest workers pool, Biome.
Later phases fill in the module map above per `docs/MASTER_BUILD_PROMPT.md`.
