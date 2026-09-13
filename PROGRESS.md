# RepoLens — Progress Tracker

Single source of truth across sessions. Update factually after every
milestone. "Not run" means it was not run — never fabricate.

## Status

- [x] Phase 1 — Foundation
- [ ] Phase 2 — GitHub App Security            **(current — next)**
- [ ] Phase 3 — Repository Onboarding
- [ ] Phase 4 — PR Review MVP
- [ ] Phase 5 — Reliability & Security
- [ ] Phase 6 — Deployment & Release

Project status: Phase 1 complete (2026-09-13). Quality gate passed with
evidence below. Repo was initialized as a git repository this session
(no prior history existed).

## Current phase — Phase 2: GitHub App Security (next)

Milestones (from spec §15):

- [ ] JWT (RS256) app authentication signing
- [ ] Installation token fetch + KV cache
- [ ] HMAC-SHA256 webhook signature verification (constant-time)
- [ ] Delivery-id idempotency via KV (TTL ~24h)
- [ ] `ping` and `installation` created/deleted event handling
- [ ] Guidance for manual app registration (spec §6)

Exact next action: implement `src/github/verify.ts` (HMAC) +
`src/github/auth.ts` (JWT/installation tokens) with tests using mocked
fetch/keys — no real GitHub API calls. See §6 for the manual app
registration the student performs (needed before live integration
testing, not before code + tests).

## Completed — Phase 1: Foundation

Milestones:

- [x] TypeScript strict project + package.json + tsconfig
- [x] Hono app with `/healthz` route
- [x] Webhook route stub (always 200, no processing yet)
- [x] wrangler.jsonc with KV + Queue bindings defined
- [x] Vitest + Workers test pool configured, passing tests
- [x] Biome configured (lint + format)
- [x] smee.io local webhook loop verified
- [x] docs/ scaffold: architecture.md, design-decisions.md

Notes:

- `@cloudflare/vitest-pool-workers` was renamed by Cloudflare to
  `@cloudflare/vitest-plugin` (Vitest 4+ API, `cloudflareTest()` plugin).
  We use the new package (v1.1.8) with `vitest@^4.1.0`; config lives in
  `vitest.config.ts`.
- Biome 2.x: `rules.recommended: true` is deprecated in favor of
  `rules.preset: "recommended"` — we use the new key.
- `src/routes/webhook.ts` exports `handleWebhook(request, env)` — raw
  Request + Env signature chosen deliberately so Phase 2 can add HMAC
  verification, KV dedupe, and enqueueing without refactoring.
- wrangler.jsonc KV id is a documented local placeholder; real namespace
  is created in Phase 6. Tests use local miniflare bindings.

## Validation log

| Check | Result | Notes |
|---|---|---|
| vitest | Pass (2026-09-13) | 3 tests / 1 file, Workers pool (workerd), v4.1.11 |
| biome check | Pass (2026-09-13) | 10 files, 0 errors, exit 0 |
| tsc --noEmit | Pass (2026-09-13) | strict, exit 0 |
| wrangler dev smoke | Pass (2026-09-13) | curl: GET /healthz → 200 JSON body; POST /webhook → 200 |
| smee webhook loop | Pass (2026-09-13) | curl POST (ping event) → smee.io channel → smee-client → wrangler `POST /webhook 200 OK` in log |
| CI | Not run | Workflow is added in Phase 6 per spec |

## Decisions log

| Date | Decision | Reason |
|---|---|---|
| — | Stack per MASTER_BUILD_PROMPT §4 | Fixed decisions |
| 2026-09-13 | `@cloudflare/vitest-plugin` instead of `@cloudflare/vitest-pool-workers` | Official successor package; old one requires Vitest 4 peer but exports only the new plugin API |
| 2026-09-13 | `handleWebhook(request, env)` raw signature | Testable directly and Phase 2-ready (headers + bindings available) |
| 2026-09-13 | smee-client as devDependency | Verifiable local webhook loop (npm-run-able), used by student during dev |

## Blockers

- GitHub App registration (manual, spec §6) — required before Phase 2
  live integration testing (real install events). Code + mocked tests for
  Phase 2 proceed without it.

## Session handoff

```text
Date: 2026-09-13
Phase: 1 → 2 transition (Phase 1 complete)
Completed this session:
  - git init (repo had no .git), full Phase 1 scaffold
  - package.json + tsconfig(strict) + wrangler.jsonc (KV+Queue bindings)
  - Hono app: /healthz + /webhook stub; src/env.ts bindings type
  - Vitest 4 + @cloudflare/vitest-plugin (workerd pool), 3 passing tests
  - Biome 2 config (preset key), LICENSE, README, docs scaffold
  - wrangler dev smoke verified; smee.io loop verified end to end
Evidence (actual command results):
  - vitest run: 1 file, 3 tests passed
  - biome check: exit 0 (10 files)
  - tsc --noEmit: exit 0
  - curl /healthz → HTTP 200 {"ok":true,"service":"repolens"}
  - curl POST /webhook → HTTP 200; wrangler log: POST /webhook 200 OK
  - smee: "POST http://127.0.0.1:8787/webhook - 200" in smee-client log;
    "POST /webhook 200 OK" in wrangler log
Next exact action: Phase 2 — src/github/verify.ts + auth.ts with mocked
tests (HMAC verify, JWT sign, installation token, KV idempotency, ping/
installation handlers).
Blockers: none for Phase 2 code/tests; app registration needed only for
live integration verification.
```
