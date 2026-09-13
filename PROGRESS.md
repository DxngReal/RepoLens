# RepoLens — Progress Tracker

Single source of truth across sessions. Update factually after every
milestone. "Not run" means it was not run — never fabricate.

## Status

- [x] Phase 1 — Foundation
- [x] Phase 2 — GitHub App Security (code + tests + smoke done; live
      install verification pending app registration)
- [ ] Phase 3 — Repository Onboarding   **(current — next)**
- [ ] Phase 4 — PR Review MVP
- [ ] Phase 5 — Reliability & Security
- [ ] Phase 6 — Deployment & Release

Project status: Phases 1–2 complete (2026-09-13). Quality gates passed
with evidence below. Live GitHub integration (real install events) still
requires the manual app registration — tracked under Blockers; it gates
Phase 2's *live* milestone but not Phase 3 implementation work.

## Current phase — Phase 3: Repository Onboarding (next)

Milestones (from spec §15, §8):

- [ ] Manifest detection (package.json, tsconfig.json, requirements.txt,
      pyproject.toml, go.mod, Cargo.toml, pom.xml, composer.json, Gemfile)
- [ ] Repo tree fetching + top-level structure (ignore node_modules/dist/build/.git)
- [ ] Deterministic onboarding report builder
- [ ] Issue posting (`RepoLens onboarding report`)
- [ ] `.repolens.yml` parsing + validation + safe defaults (spec §10)
- [ ] Wire installation.created → onboarding job (inline until Phase 4 queue)

Exact next action: implement `src/analyze/manifests.ts` + tests with
fixture JSON, then `src/config/repolens-yml.ts` (defaults on any error),
then report builder + `src/github/repos.ts`/`issues.ts` with mocked
Octokit-style fetch. All GitHub calls mocked in tests.

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
| vitest | Pass (2026-09-13) | 28 tests / 3 files: HMAC (7), PEM/JWT (5), token cache (4), webhook route (11), health (1) |
| biome check | Pass (2026-09-13) | 14 files, exit 0 |
| tsc --noEmit | Pass (2026-09-13) | strict, exit 0 |
| wrangler dev smoke | Pass (2026-09-13) | unsigned→401; signed ping→200; duplicate delivery→200 skipped; wrong-secret→401; safe log lines observed |
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

## Blockers

- GitHub App registration (manual, spec §6) — required for live install
  event verification. All code paths are covered by mocked tests + local
  smoke tests meanwhile. Step-by-step guidance is at the bottom of this
  file; share when ready to register.

## Session handoff

```text
Date: 2026-09-13
Phase: 2 → 3 transition (Phases 1–2 complete)
Completed this session:
  - Phase 1 full scaffold + gate (commit 0f0d319)
  - Phase 2: verify.ts, auth.ts (JWT + installation token + KV cache),
    webhook route (401/400/dedupe/ping/installation), 25 new tests,
    wrangler dev smoke of all four security paths
Evidence (actual command results):
  - vitest run: 3 files, 28 tests passed
  - biome check: exit 0 (14 files)
  - tsc --noEmit: exit 0
  - wrangler dev smoke: 401 unsigned / 200 signed / duplicate skipped /
    401 wrong secret; logs show safe single-line messages only
Next exact action: Phase 3 — src/analyze/manifests.ts + fixture tests,
then .repolens.yml config parser, then onboarding report builder and
github/repos.ts + github/issues.ts with mocked fetch; wire
installation.created → onboarding issue.
Blockers: none for Phase 3 code/tests; live verification needs app
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
