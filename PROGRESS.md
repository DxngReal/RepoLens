# RepoLens — Progress Tracker

Single source of truth across sessions. Update factually after every
milestone. "Not run" means it was not run — never fabricate.

## Status

- [x] Phase 1 — Foundation
- [x] Phase 2 — GitHub App Security (code + tests + smoke done; live
      install verification pending app registration)
- [x] Phase 3 — Repository Onboarding (code + tests + smoke done; live
      end-to-end install verification pending app registration)
- [ ] Phase 4 — PR Review MVP   **(current — next)**
- [ ] Phase 5 — Reliability & Security
- [ ] Phase 6 — Deployment & Release

Project status: Phases 1–3 complete (2026-09-13). Quality gates passed
with evidence below. Live GitHub integration (real install events →
onboarding issue) still requires the manual app registration — tracked
under Blockers; it gates live verification but not Phase 4 implementation
work.

## Current phase — Phase 4: PR Review MVP (next)

Milestones (from spec §15, §9):

- [ ] `src/github/pulls.ts` — PR files API fetch (per-file patch, status)
- [ ] `src/analyze/diff.ts` — filters (lockfiles/binaries/generated/>500
      changed lines) + budget (default 1500 changed lines) + skipped notes
- [ ] `src/llm/provider.ts` — LLMProvider interface + prompt templates
      (repo content delimited as untrusted data)
- [ ] `src/llm/gemini.ts` — Gemini Flash adapter behind the interface
- [ ] `src/queue/consumer.ts` — onboarding_job/review_job handlers; move
      webhook inline `waitUntil` work to queue producer/consumer
- [ ] Single `### RepoLens review` comment per delivery; empty/fully
      filtered diff → no comment; `synchronize` → new comment (no updates)

Exact next action: implement `src/github/pulls.ts` + mocked-fetch tests,
then `src/analyze/diff.ts` filter/budget tests, then `src/llm/provider.ts`
+ `src/llm/gemini.ts` with mocked fetch, then queue consumer + webhook
producer wiring; wrangler dev smoke with a signed `pull_request` event.

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
| vitest | Pass (2026-09-13, Phase 3) | 7 files, 76 tests: HMAC (7), PEM/JWT (5), token cache (4), webhook route (15 incl. onboarding wiring), health (1), manifests (15), repolens-yml (11), onboarding report/job (7), repos/issues helpers (11) |
| biome check | Pass (2026-09-13, Phase 3) | 23 files, exit 0 |
| tsc --noEmit | Pass (2026-09-13, Phase 3) | strict, exit 0 |
| wrangler dev smoke | Pass (2026-09-13, Phase 3) | unsigned→401; wrong secret→401; signed ping→200; signed installation.created→200; duplicate delivery→200 skipped; healthz→200; logs safe single lines only. (First smoke run of case 4 sent a mismatched-signature body — worker correctly returned 401; re-run with correct signature → 200.) |
| smee webhook loop | Pass (2026-09-13, Phase 1) | end-to-end channel → local worker 200 |
| CI | Not run | Workflow is added in Phase 6 per spec |
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
Phase: 3 → 4 transition (Phases 1–3 complete)
Completed this session:
  - Phase 3: manifests.ts, repolens-yml.ts, repos.ts, issues.ts,
    onboarding.ts (report builder + job runner), webhook wiring of
    installation.created → per-repo onboarding jobs
  - Fixed corrupted escapes in onboarding.ts (previous session), fixed
    webhook wiring test (real test RSA key + serving mock), rejected
    flow collections in the YAML subset, deleted debug-report.test.ts
Evidence (actual command results):
  - vitest run: 7 files, 76 tests passed
  - biome check: exit 0 (23 files)
  - tsc --noEmit: exit 0
  - wrangler dev smoke: 401 unsigned / 401 wrong secret / 200 signed ping
    / 200 signed installation.created / 200 duplicate skipped / 200
    healthz; logs show safe single-line messages only; disposable
    .dev.vars deleted after
Next exact action: Phase 4 — src/github/pulls.ts + diff budgets +
LLMProvider + Gemini adapter + queue producer/consumer; single review
comment per delivery; mocked tests only; wrangler dev smoke with signed
pull_request event.
Blockers: none for Phase 4 code/tests; live verification needs app
registration (manual).
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
