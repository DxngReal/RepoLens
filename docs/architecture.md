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
| `src/github/repos.ts` | Tree/contents helpers | done (Phase 3) |
| `src/github/issues.ts` | Create issue / PR comment | done (Phase 3/4) |
| `src/github/pulls.ts` | PR metadata + changed-files fetch (3 pages max) | done (Phase 4) |
| `src/analyze/manifests.ts` | Manifest detection + dependency counts | done (Phase 3) |
| `src/analyze/onboarding.ts` | Deterministic report builder + onboarding job | done (Phase 3) |
| `src/analyze/diff.ts` | Filters (lockfile/generated/no-patch/too-large), 1500-line budget, exclude globs | done (Phase 4) |
| `src/analyze/review.ts` | Review job: prompt → LLM → verify contract → sanitize → one comment | done (Phase 4/5) |
| `src/llm/provider.ts` | `LLMProvider` interface + injection-fenced prompts + redaction choke point | done (Phase 4/5) |
| `src/llm/gemini.ts` | Gemini Flash adapter (status-only errors, timeout + retry) | done (Phase 4/5) |
| `src/queue/consumer.ts` | onboarding_job / review_job handlers, ack/retry/DLQ policy | done (Phase 4) |
| `src/config/repolens-yml.ts` | `.repolens.yml` parse + validate + defaults | done (Phase 3) |
| `src/util/retry.ts` | `fetchWithRetry`: 429/5xx + network retry, exponential backoff, Retry-After | done (Phase 5) |
| `src/util/redact.ts` | `redactSecrets`: token/PEM/key=value/Authorization patterns before LLM egress | done (Phase 5) |
| `src/errors.ts` | Error taxonomy (`GitHubError`/`LLMError`) + `logSafe` single-line logger | done (Phase 5) |

Phase 4 note: jobs go to `REVIEW_QUEUE` when the binding is present
(production); without a binding (unit tests, minimal local dev) the same
job runs inline under `waitUntil`, and a failed `queue.send` degrades to
inline execution. A missing `GEMINI_API_KEY` (or an LLM error) degrades
the review to a deterministic-only comment with an explicit note —
never a fake or half review.

## Key invariants

- Webhook handler performs no GitHub/LLM calls before responding.
- All repository content is untrusted data: diff and file text is
  delimited in prompts and never executed as instructions.
- Exactly one PR review comment per delivery; duplicate delivery ids are
  skipped via KV (TTL ~24h).
- Secrets exist only as Wrangler secrets / Worker env — never in code,
  git, logs, or bot comments.

## Status

Phases 1–5 are complete: Hono app, `/healthz`, webhook HMAC verification
(fail-closed 401), KV delivery-id idempotency (24h TTL), RS256 JWT
signing via WebCrypto, installation token fetching with KV cache,
`ping`/`installation`/`pull_request` routing, the onboarding pipeline
(manifest detection, root-tree fetch, `.repolens.yml` config, escaped
deterministic report, report issue posting), and the PR review pipeline
(files API → filters/budgets → LLMProvider/Gemini → output-contract
verification → sanitized single `### RepoLens review` comment;
deterministic degrade on LLM failure; queue producer/consumer with
ack/retry/DLQ). Phase 5 added: per-call retry with exponential backoff
on all GitHub/LLM fetches (429/5xx/network, Retry-After aware), secret
redaction at the prompt-assembly choke point, a mechanical output-
contract gate (end marker + required headings) with degrade on
violation, a shared error taxonomy, and `logSafe` single-line logging
with delivery-id correlation. Next: Phase 6 — deployment & release.
