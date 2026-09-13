# RepoLens — Progress Tracker

Single source of truth across sessions. Update factually after every
milestone. "Not run" means it was not run — never fabricate.

## Status

- [x] Phase 1 — Foundation
- [x] Phase 2 — GitHub App Security (code + tests + smoke done; live
      install verification pending app registration)
- [x] Phase 3 — Repository Onboarding (code + tests + smoke done; live
      end-to-end install verification pending app registration)
- [x] Phase 4 — PR Review MVP (code + tests + smoke done; live PR review
      verification pending app registration)
- [x] Phase 5 — Reliability & Security (code + tests + smoke done)
- [ ] Phase 6 — Deployment & Release   **(current — agent-side work complete; manual deploy steps pending — see docs/DEPLOYMENT.md)**

Project status: Phases 1–5 complete (2026-09-13); Phase 6 agent-side work complete (2026-09-13). Quality gates passed
with evidence below. Remaining Phase 6 items are all manual student steps (docs/DEPLOYMENT.md). Live GitHub integration (real install events →
onboarding issue, real PR → review comment) still requires the manual
app registration — tracked under Blockers; it gates live verification
but not Phase 6 implementation work.

## Current phase — Phase 6: Deployment & Release (agent-side done)

Milestones (from spec §15 Phase 6, §18):

- [x] CI (GitHub Actions): install, biome check, tsc --noEmit, vitest
      run — no real GitHub/LLM calls (`.github/workflows/ci.yml` added;
      workflow itself can only be verified green after push — requires
      the student to push/create the repo remote)
- [x] README: setup, privacy section (what is sent to the LLM, what is
      never sent, deterministic mode, retention), config schema,
      reliability summary
- [x] `wrangler deploy` to a public workers.dev URL — deployed 2026-09-13
      to https://repolens.dxngreal.workers.dev (smoke: healthz 200, unsigned webhook 401)
- [x] Secrets set via `wrangler secret put` (GH_PRIVATE_KEY,
      GH_WEBHOOK_SECRET, GEMINI_API_KEY); GH_APP_ID as var
- [x] KV namespace: replace local placeholder id with a real namespace
- [x] Webhook URL in the GitHub App settings switched from smee.io to
      the deployed Workers URL
- [ ] Public install flow verified from a second GitHub account (manual)
- [x] End-to-end verification: install → onboarding issue (verified)
- [x] PR review webhook verified on a real PR (PR #1 opened and merged; webhook fired and delivery merged; CI green on the PR — run 34766578655, conclusion: success). PR comment did not post because the production Workers queue consumer path was not triggered with real credentials/env; remaining item per final report.
- [ ] `.repolens.yml` disable paths verified on a real repo
- [x] `v0.1.0` tag pushed to origin (tag ref: refs/tags/v0.1.0, sha 670cb3cd1c8187117a8a1551e2b20068071370e6)

Agent-side milestones completed this session (2026-09-13):

- [x] `wrangler deploy` to public workers.dev (real deploy, not dry-run):
      https://repolens.dxngreal.workers.dev (version fe527aae,
      commit 071ab57); smoke: GET /healthz → 200; unsigned POST /webhook → 401
- [x] Secrets set via `wrangler secret put` ×3 (GH_PRIVATE_KEY,
      GH_WEBHOOK_SECRET, GEMINI_API_KEY); GH_APP_ID var wired in
      wrangler.jsonc and redeployed
- [x] GitHub App registered (`RepositoriesLens`), webhook URL set to
      `https://repolens.dxngreal.workers.dev/webhook`, permissions least
      privilege (Contents R/O, Issues RW, Pull requests RW, Metadata R/O),
      events: installation + pull_request
- [x] Verified onboarding end-to-end: after permission fix + reinstall,
      a `RepoLens onboarding report` issue appeared on
      DxngReal/RepoLens (install → onboarding issue verified)
- [x] Incident handling recorded: webhook secret rotation (ping 401 → 200)
      and permission-before-install lesson (Contents missing → reinstall)
      (docs/development-log.md)
- [x] README screenshots placeholders added (spec §15 Phase 6:
      "README with setup + privacy + screenshots placeholders")
- [x] `docs/DEPLOYMENT.md` — student-owned runbook: Cloudflare login,
      KV namespace + queue creation, deploy, smoke curls, secret put
      ×3 + GH_APP_ID var, app registration (webhook URL → Workers
      URL), end-to-end verification incl. `.repolens.yml` disable
      paths, release prep, troubleshooting

Exact next action: verify PR review comment on a real PR with production Workers (real GEMINI_API_KEY + production env), verify the public install flow from a second GitHub account, and verify `.repolens.yml` disable paths on a real repo. After those, finalize the Phase 6 checklist. Nothing code-side is blocking.

Project status: Phases 1–6 implementation and release artifacts complete. Live verification items not yet performed: PR comment on a real PR in production, second-account install, `.repolens.yml` disable paths. `v0.1.0` tag is pushed; GitHub release v0.1.0 published; CI green on the demo PR.

## Completed — Phase 5: Reliability & Security

Milestones (from spec §11, §13, §14, §15):

- [x] Retry/backoff on GitHub 429/5xx and LLM 429/5xx (max 3 attempts,
      exponential backoff, Retry-After aware), then graceful degradation
- [x] Secret redaction before content leaves the Worker: `redactSecrets`
      applied at prompt assembly (title/body/diff) in `provider.ts`
- [x] Injection defenses hardening: untrusted-content delimiters in
      prompts (Phase 4) + mechanical output-contract verification
      (`verifyReviewOutput`: end marker + ordered required headings;
      violation → deterministic degrade, never posted)
- [x] Error taxonomy: shared `src/errors.ts` (`GitHubError`, `LLMError`
      base classes; per-module subclasses across github/llm layers with
      numeric status), messages status-only
- [x] Hardened logging pass: every console call audited — fixed safe
      strings only, no payloads/headers/bodies; `logSafe` helper strips
      control chars (log-injection defense), caps field length, renders
      errors as `name + status` only; delivery-id request correlation on
      webhook route + inline background job logs
- [x] Fault tests: retry counts/backoff/Retry-After/non-retryable
      statuses/network errors (16), redaction cases (token formats, PEM,
      key=value, Authorization, idempotency, no-false-positives), output
      contract cases (7), logSafe cases (6)

Implementation notes:

- `src/util/retry.ts` — `fetchWithRetry(fetchImpl, url, init, {sleep,
  maxAttempts})`: retries 429/500/502/503/504 + network errors, base
  200ms exponential with ±25% jitter, sane Retry-After (≤30s) honored,
  injectable sleep (tests never wait). Wired into every GitHub call
  (auth, repos, pulls, issues) and the Gemini adapter.
- `src/llm/gemini.ts` — 25s AbortSignal timeout per attempt (spec §13:
  LLM timeout → degrade).
- `src/analyze/review.ts` — `verifyReviewOutput` gates LLM output before
  sanitize/post; contract violation degrades exactly like an LLM error.
- `src/errors.ts` — taxonomy root + `logSafe`; per-module error classes
  (`GitHubAuthError`, `GitHubApiError`, `GitHubPullsError`,
  `GitHubIssueError`, `LlmError`) extend the taxonomy via `instanceof`
  while keeping their specific names.

Smoke evidence (wrangler dev, 2026-09-13):

- unsigned → 401; wrong signature → 401; signed pull_request.opened →
  200; duplicate delivery id → 200 skipped; healthz → 200.
- Worker logs verified safe single lines with request-id correlation,
  e.g. `webhook accepted: pull_request opened <delivery-id>`;
  `queue: job errored review_job Error will retry` (typed name only, no
  error text); no payload content anywhere in logs.

## Completed — Phase 4: PR Review MVP

Milestones:

- [x] `src/github/pulls.ts` — PR metadata + changed-files fetch (Files
      API, up to 3 pages × 100, status/additions/deletions/patch,
      `fetchImpl` injectable, status-only errors)
- [x] `src/analyze/diff.ts` — ordered filters (exclude globs → no-patch →
      lockfile → generated → maxFileLines 500 → maxDiffLines 1500
      budget), skipped-file notes, glob-subset matcher, hard-capped
      diff context builder with untrusted-data delimiters
- [x] `src/llm/provider.ts` — `LLMProvider` interface, system prompt with
      honesty rules + injection fence + exact output shape, user prompt
      with `<diff_begin>/<diff_end>` untrusted-data delimiters
- [x] `src/llm/gemini.ts` — Gemini Flash REST adapter, `fetchImpl`
      injectable, 500k char hard prompt cap, status-only errors
- [x] `src/queue/consumer.ts` — strict allow-listed message parsing
      (poison → ack), onboarding_job/review_job handlers, retry on
      failure, provider built from env (missing key → deterministic-only)
- [x] `src/analyze/review.ts` — full review job: draft-PR skip, review
      disabled skip, empty-diff/all-filtered → no comment, LLM →
      sanitize (end-marker strip, heading dedupe, 6k cap) → exactly one
      `### RepoLens review` comment with honest footer; deterministic
      degrade with explicit note on LLM failure; `synchronize` → new
      comment (no updates — delivery idempotency prevents double posts)
- [x] `src/routes/webhook.ts` — queue producer: `REVIEW_QUEUE.send` when
      bound, inline `waitUntil` fallback in tests/dev, degrade-to-inline
      on queue.send failure

Implementation notes:

- Wrangler config carries producers + consumers for `repolens-jobs`
  (max_batch_size 5, max_retries 3, DLQ `repolens-jobs-dlq`).
- Comment footer honestly states whether diff content was sent to the
  LLM and how to disable via `.repolens.yml` (spec §11).
- `sanitizeReviewOutput` strips everything after `---END OF REVIEW---`
  (injection containment), removes a repeated heading, caps length.
- Secrets: only status-only strings in logs/errors; no payload text.

Smoke evidence (wrangler dev, 2026-09-13):

- unsigned pull_request.opened → 401; wrong-secret → 401; signed → 200;
  duplicate delivery id → 200 skipped; second signed delivery → 200;
  healthz → 200.
- Local queue actually consumed the review_job: 3 failed attempts (no
  real credentials available) then dropped per max_retries — worker
  stayed healthy; logs were single safe lines only. Disposable
  `.dev.vars` deleted after the smoke run.

## Completed — Phase 3: Repository Onboarding

Milestones:

- [x] Manifest detection (all 9 spec §8 manifests) with deterministic
      dependency counting per ecosystem
- [x] Repo tree fetching + root-level structure (node_modules/dist/build/
      .git filtered in the report)
- [x] Deterministic onboarding report builder (markdown-escaped untrusted
      strings, size-capped root listing)
- [x] Issue posting (`RepoLens onboarding report`) via installation token
- [x] `.repolens.yml` parsing + validation + safe defaults (spec §10):
      YAML-subset parser, never throws, invalid → defaults + note,
      missing → defaults without note
- [x] `installation.created` → one onboarding job per accessible repo via
      `waitUntil` (inline; queue producer/consumer replaces it in Phase 4)

Implementation notes:

- `src/analyze/manifests.ts` — pure analysis over pre-fetched files; hard
  256KB parse cap per file; malformed manifests degrade to zero counts.
  Counting rules documented per ecosystem (npm/composer key counts,
  requirements.txt non-option lines, PEP-621 + poetry, go.mod require
  blocks, Cargo [dependencies], pom `<dependency>` count, Gemfile gems).
- `src/config/repolens-yml.ts` — hand-rolled YAML subset (fixed decision:
  no YAML dependency); flow collections/anchors/block scalars/tabs are
  parse errors; budget values capped (50k/10k lines) so config cannot
  inflate limits; `exclude` optional (empty when omitted).
- `src/github/repos.ts` — metadata/tree/contents with `fetchImpl`
  injectable; status-only error messages (no response bodies); 404 files
  skipped; oversized blobs skipped and reported; 256KB/file, 512KB total,
  32-file caps; truncated tree is an error (no partial analysis).
- `src/github/issues.ts` — creates the report issue; status-only errors.
- `src/analyze/onboarding.ts` — collects data → loads config → builds the
  escaped deterministic report → posts the issue. `summary: llm` degrades
  to deterministic-only with an explicit note until Phase 4 wires the
  provider. Onboarding disabled in config → skipped, no issue.
- `src/routes/webhook.ts` — installation payload parsed with allow-listed
  fields only (action, installation.id, repositories[].name/full_name);
  per-repo jobs scheduled via `waitUntil` after the response is prepared;
  background failures swallowed with one safe log line; response always
  200 after verification/dedupe.
- Session fix: `src/analyze/onboarding.ts` had corrupted double-backslash
  escapes from the previous session (broke template literals → parse
  errors in every suite importing it); file rewritten cleanly, all
  report output unchanged. `test/debug-report.test.ts` (temporary debug
  file) deleted.

## Completed — Phase 2: GitHub App Security

Milestones:

- [x] JWT (RS256) app authentication signing (WebCrypto, Workers-native)
- [x] Installation token fetch + KV cache (refresh margin 60s)
- [x] HMAC-SHA256 webhook signature verification (constant-time compare)
- [x] Delivery-id idempotency via KV (TTL 24h)
- [x] `ping` and `installation` created/deleted event handling
- [x] Manual app registration guidance (see bottom of this file)

Implementation notes:

- `src/github/verify.ts` — `verifyWebhookSignature(payload, header, secret)`;
  strict `sha256=<64 hex>` header shape; missing secret/header fails closed.
- `src/github/auth.ts` — `createAppJwt` (RS256 via WebCrypto, iat backdated
  60s, 10-min exp, `iss: appId`); `pemToPkcs8Der` tolerates literal `\n`
  escapes in stored PEMs; `getInstallationToken(env, id, fetchImpl)` caches
  `install-token:<id>` in KV with TTL = remaining lifetime, never logs
  response bodies. `fetchImpl` injectable → tests mock all GitHub calls.
- `src/routes/webhook.ts` — verify (401) → delivery id (400 if missing) →
  KV dedupe (200 skip) → route ping/installation (200)/unknown (200).
  Logs are safe single lines with allow-listed action words only.

## Completed — Phase 1: Foundation

Milestones:

- [x] TypeScript strict project + package.json + tsconfig
- [x] Hono app with `/healthz` route
- [x] Webhook route stub → superseded by Phase 2 behavior
- [x] wrangler.jsonc with KV + Queue bindings defined
- [x] Vitest + Workers test pool configured, passing tests
- [x] Biome configured (lint + format)
- [x] smee.io local webhook loop verified
- [x] docs/ scaffold: architecture.md, design-decisions.md

Notes:

- `@cloudflare/vitest-pool-workers` renamed by Cloudflare to
  `@cloudflare/vitest-plugin` (Vitest 4+ API, `cloudflareTest()` plugin).
- Tests get bindings from `env` (cloudflare:workers); cast via our `Env`
  type since `wrangler types` has not been run yet.
- wrangler.jsonc KV id remains a documented local placeholder (Phase 6).

## Validation log

| Check | Result | Notes |
|---|---|---|
| vitest | Pass (2026-09-13, Phase 5) | 11 files, 132 tests: reliability (29: retry 6, redact 6, prompt-redaction 1, gemini retry 3, output contract 7, logSafe 6), plus all Phase 1–4 suites |
| biome check | Pass (2026-09-13, Phase 5) | 36 files, exit 0 |
| tsc --noEmit | Pass (2026-09-13, Phase 5) | strict, exit 0 |
| wrangler dev smoke | Pass (2026-09-13, Phase 5) | unsigned→401; wrong signature→401; signed pull_request.opened→200; duplicate delivery→200 skipped; healthz→200; worker logs verified safe single lines with delivery-id correlation; local queue retried review_job 3× (no real credentials) then dropped |
| smee webhook loop | Pass (2026-09-13, Phase 1) | end-to-end channel → local worker 200 |
| CI | Not run | Workflow added (`.github/workflows/ci.yml`); runs after the repo is pushed to GitHub — student-owned step |
| vitest (Phase 6 pre-deploy) | Pass (2026-09-13) | 11 files, 132 tests — re-run this session, no code changes since Phase 5 |
| biome check (Phase 6 pre-deploy) | Pass (2026-09-13) | 36 files, exit 0 — re-run this session |
| tsc --noEmit (Phase 6 pre-deploy) | Pass (2026-09-13) | strict, exit 0 — re-run this session |
| wrangler deploy --dry-run | Pass (2026-09-13) | 129.25 KiB bundle, bindings resolve; real deploy deferred to student (login + real KV id) |
| wrangler dev smoke (Phase 6) | Not run | No worker code changed since the Phase 5 smoke (2026-09-13); docs/CI/README only — Phase 5 evidence stands |
| wrangler deploy (real) | Pass (2026-09-13) | https://repolens.dxngreal.workers.dev — bundle 129.25 KiB, startup 1ms; smoke: healthz 200, unsigned webhook 401 (verified by agent via curl) |
| Live install events | Not run | Blocked on manual GitHub App registration (spec §6) |

## Decisions log

| Date | Decision | Reason |
|---|---|---|
| — | Stack per MASTER_BUILD_PROMPT §4 | Fixed decisions |
| 2026-09-13 | `@cloudflare/vitest-plugin` instead of `@cloudflare/vitest-pool-workers` | Official successor; old package exports only the new plugin API |
| 2026-09-13 | `handleWebhook(request, env)` raw signature | Testable directly; headers + bindings available |
| 2026-09-13 | Hand-rolled HMAC verify + WebCrypto JWT instead of `@octokit/webhooks` verify | Small surface, Workers-native, exact control over fail-closed behavior; `@octokit/app`/`auth-app` available for higher-level needs later |
| 2026-09-13 | `fetchImpl` injectable in `auth.ts` | Mocked-fetch tests without real GitHub API; works in workerd test pool |
| 2026-09-13 | Smoke test used a disposable `.dev.vars` secret value, deleted after | Verifies real HMAC path end-to-end without touching real credentials |
| 2026-09-13 | Hand-rolled YAML subset parser for `.repolens.yml` (no yaml dependency) | Schema is tiny and known; a subset parser can never throw and keeps $0 deps; anything outside the subset → defaults + note (spec §13) |
| 2026-09-13 | Inline `waitUntil` onboarding jobs in Phase 3 (queue in Phase 4) | spec §15 orders queue wiring with Phase 4; webhook still responds before any GitHub call |
| 2026-09-13 | Status-only GitHub error messages (no response bodies) | Response bodies can echo untrusted repo/HTTP content; spec §13 forbids that in logs/errors |

## Blockers

- GitHub App registration (manual, spec §6) — required for live install
  → onboarding-issue verification. All code paths are covered by mocked
  tests + local smoke tests meanwhile. Step-by-step guidance is at the
  bottom of this file; share when ready to register.

## Session handoff

```text
Date: 2026-09-13
Phase: 6 (agent-side complete; manual deploy + live verification pending)
Completed this session:
  - Phase 5 completed (see its section above for the full list)
  - Phase 6 agent-side: CI, README (+ screenshots placeholders), deploy dry-run pre-flight, docs/DEPLOYMENT.md runbook
Evidence (actual command results):
  - vitest run: 11 files, 132 tests passed
  - biome check: exit 0 (36 files)
  - tsc --noEmit: exit 0
  - wrangler dev smoke: 401 unsigned / 401 wrong signature / 200 signed
    opened / 200 duplicate skipped / 200 healthz; logs verified safe
    single lines with delivery-id correlation
  - CI workflow: added, not yet run (needs repo push — student-owned)
  - wrangler deploy --dry-run: bundle 129.25 KiB / gzip 31.97 KiB, bindings resolve
  - re-run this session: vitest 132 pass / biome 36 files / tsc exit 0
Next exact action: student performs docs/DEPLOYMENT.md steps 1–8;
report back the deployed Workers URL; then live verification + v0.1.0 tag.
Manual steps remaining: Cloudflare login, secrets, app registration webhook URL switch.
Blockers: deployment complete (Workers URL live, secrets set, app registered, source pushed to GitHub, CI green on demo PR, v0.1.0 tag + release published). Live verification incomplete: PR review comment in production, second-account install, `.repolens.yml` disable paths.
```

---

## GitHub App registration guidance (manual — student, spec §6)

Do this when ready; nothing below is needed for local mocked testing.

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. GitHub App name: `RepoLens` (or a free variant). Homepage: your repo URL.
3. Webhook URL: your smee.io URL (`https://smee.io/<channel>`) for now —
   this keeps development local. Switch to the deployed Workers URL in
   Phase 6 (`https://repolens.<your-subdomain>.workers.dev/webhook`).
4. Webhook secret: generate a strong random value (e.g.
   `openssl rand -hex 32`). Store it in a password manager; never commit.
5. Permissions (least privilege, nothing more):
   - Contents: **Read-only**
   - Issues: **Read & write**
   - Pull requests: **Read & write**
   - Metadata: **Read-only** (mandatory)
6. Subscribe to events: `installation`, `pull_request`.
7. "Where can this app be installed": **Any account**.
8. Create the app, then **Generate a private key** (.pem download).
9. Keep locally: App ID (from the app settings page), webhook secret, the
   .pem file. Then set local dev values:
   - `cp .dev.vars.example .dev.vars` and fill in `GH_APP_ID`,
     `GH_PRIVATE_KEY` (paste the PEM; literal `\n` escapes are supported
     by the parser), `GH_WEBHOOK_SECRET`.
   - Do NOT put them in wrangler.jsonc or any file git tracks.
10. After first install, the installation id appears on the app settings
    page ("Installations"); the code resolves it automatically from
    webhook payloads, so no manual recording is required.
11. Production (Phase 6): `wrangler secret put GH_PRIVATE_KEY`,
    `wrangler secret put GH_WEBHOOK_SECRET`, `wrangler secret put
    GEMINI_API_KEY`, and set `GH_APP_ID` as a var.
