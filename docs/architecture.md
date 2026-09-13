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

| Module | Responsibility | Status |
|---|---|---|
| `src/index.ts` | Hono app + Workers fetch handler | done |
| `src/env.ts` | Bindings: vars, secrets, KV, Queue | done |
| `src/routes/webhook.ts` | Verify HMAC → dedupe → route events | done (Phase 2) |
| `src/github/verify.ts` | X-Hub-Signature-256 verification (constant-time) | done (Phase 2) |
| `src/github/auth.ts` | App JWT (RS256/WebCrypto), installation token + KV cache | done (Phase 2) |
| `src/github/repos.ts` | Tree/contents helpers | Phase 3 |
| `src/github/issues.ts` | Create issue / PR comment | Phase 3–4 |
| `src/github/pulls.ts` | Fetch PR diff/files | Phase 4 |
| `src/analyze/*` | Manifests, onboarding report, diff budgets | Phase 3–4 |
| `src/llm/*` | LLMProvider interface, Gemini adapter, prompts | Phase 4 |
| `src/queue/consumer.ts` | onboarding_job / review_job handlers | Phase 4 |
| `src/config/repolens-yml.ts` | `.repolens.yml` parse + validate + defaults | Phase 3 |

## Key invariants

- Webhook handler performs no GitHub/LLM calls before responding.
- All repository content is untrusted data: diff and file text is
  delimited in prompts and never executed as instructions.
- Exactly one PR review comment per delivery; duplicate delivery ids are
  skipped via KV (TTL ~24h).
- Secrets exist only as Wrangler secrets / Worker env — never in code,
  git, logs, or bot comments.

## Status

Phase 1 (Foundation) and Phase 2 (GitHub App Security) are complete:
Hono app, `/healthz`, webhook HMAC verification with fail-closed 401,
KV delivery-id idempotency (24h TTL), RS256 JWT signing via WebCrypto,
installation token fetching with KV cache, ping/installation event
routing. Next: Phase 3 fills in the onboarding analysis modules per
`docs/MASTER_BUILD_PROMPT.md` §8.
