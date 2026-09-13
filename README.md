# RepoLens

A GitHub App that helps people understand unfamiliar repositories and
review pull requests more quickly. On install it opens an onboarding
report issue; on each pull request it posts one summary review comment.
Deterministic analysis first; LLM summaries second; everything
configurable per repo via `.repolens.yml`.

**Status: v0.1.0 — deployed and verified for onboarding and PR review**.
See `PROGRESS.md` for the live milestone tracker and
`docs/MASTER_BUILD_PROMPT.md` for the authoritative specification.

## What it does

- **Onboarding report** (on install, per repo): detected manifests
  (npm/Composer/Go/Cargo/Maven/pip/Gem/Bundler), dependency counts,
  top-level structure, license presence — as a deterministic report
  issue, no LLM required.
- **PR review** (on every opened/synchronized PR): one `### RepoLens
  review` comment with Summary / Risks / Suggestions. The LLM summary
  uses only the filtered, budgeted diff; LLM failure degrades to a
  deterministic summary with an explicit note — never a fake review.

## How to install

1. Visit the public install link:
   `https://github.com/apps/repositorieslens/installations/new`
2. Choose **Only select repositories** and pick the repository(s) you
   want, or **Any account** if you configured the app that way.
3. After install, the app opens a `RepoLens onboarding report` issue on
   each newly accessible repository within seconds.
4. Open a pull request on the repo: the app posts one summary review
   comment on the PR.

## How to self-host / deploy

RepoLens is a Cloudflare Workers app. To run your own instance:

1. Clone this repository and run `npm install`.
2. Register a GitHub App (details in `docs/MASTER_BUILD_PROMPT.md` §6
   and `docs/DEPLOYMENT.md`).
3. Create a KV namespace (`wrangler kv namespace create IDEMPOTENCY_KV`)
   and update `wrangler.jsonc` with the real namespace id.
4. Create the job queue and the DLQ (`wrangler queues create`).
5. Set secrets (`wrangler secret put GH_PRIVATE_KEY`,
   `wrangler secret put GH_WEBHOOK_SECRET`,
   `wrangler secret put GEMINI_API_KEY`) and set `GH_APP_ID` in
   `wrangler.jsonc` `vars`.
6. Deploy (`npx wrangler deploy`). Point the GitHub App webhook URL at
   the deployed Workers URL.

Full runbook: `docs/DEPLOYMENT.md`.

## Local development

```bash
npm install
npm run dev        # wrangler dev on http://127.0.0.1:8787
```

- `GET /healthz` — liveness probe
- `POST /webhook` — GitHub webhook receiver (HMAC-verified, idempotent)

### Webhook forwarding (smee.io)

```bash
npx smee-client --url https://smee.io/<your-channel> \
  --target http://127.0.0.1:8787/webhook --port 3000
```

Create a channel at https://smee.io/new and use that URL as the webhook
URL in your GitHub App settings during development.

### Secrets

Copy `.dev.vars.example` to `.dev.vars` and fill in the values from the
manual GitHub App registration (docs/MASTER_BUILD_PROMPT.md §6). Never
commit `.dev.vars` or any `.pem` key — both are git-ignored. In
production the three secret values are set with `wrangler secret put`.

## Configuration (`.repolens.yml`)

Per-repo configuration lives in the repository root:

```yaml
version: 1
onboarding:
  enabled: true
  summary: llm        # llm | deterministic
review:
  enabled: true
  max_diff_lines: 1500
  max_file_lines: 500
exclude:
  - "**/*.lock"
  - "dist/**"
```

Missing file = all defaults on. Invalid file = safe defaults with a
one-line note in the bot output (never a crash).

## Reliability & security

- Every webhook delivery is HMAC-verified (fail-closed 401) and
  deduplicated by delivery id before any processing.
- All GitHub and LLM calls retry transient failures (429/5xx/network,
  max 3 attempts, exponential backoff, Retry-After aware), then degrade
  gracefully — the worker never posts a broken half-review.
- Obvious secret patterns (provider tokens, PEM blocks, `KEY=value`
  assignments) are redacted from all content before it is sent to the
  LLM provider.
- Repository content is treated as untrusted data: delimited in
  prompts, mechanically contract-checked in output, and never executed
  as instructions.
- All repository content is untrusted data: diffs, file contents, and
  issue text are never treated as instructions, and prompt-injection
  attempts in diffs do not change behavior.

## Privacy

Plain language:

- **What leaves the repository.** When LLM features are enabled
  (default), RepoLens sends the following to its LLM provider (Google
  Gemini Flash): the PR title and description, the filtered diff of
  changed files (after applying the exclude/size budgets above), and a
  short note listing files that were skipped. Before sending, obvious
  secret-like strings (API keys, tokens, private key blocks) are
  replaced with `[REDACTED]`.
- **What never leaves the repository.** File contents that are not part
  of the diff, secrets stored in your Cloudflare/GitHub settings, and
  webhook payloads are never sent to the LLM or logged. Logs contain
  fixed status strings and delivery ids only — never code, diffs, or
  credentials.
- **Deterministic mode sends nothing.** With `onboarding.summary:
  deterministic` and/or `review.enabled: false` in `.repolens.yml`, no
  repository content is sent to any third party. The onboarding report
  is deterministic by default; only the optional LLM summary uses the
  provider.
- **Honest disclosure.** Every bot comment ends with a footer stating
  whether LLM content was sent for that comment, and how to disable it.
- **Retention.** RepoLens stores only: delivery ids (24h, for
  idempotency) and short-lived installation tokens (KV, until ~60s
  before expiry) in Cloudflare KV. Nothing else is persisted.

Full policy: docs/MASTER_BUILD_PROMPT.md §11.

## Limitations

- v0.1.0 scope is onboarding + one summary PR review comment only.
  There is no inline line-by-line review, no Q&A bot, no issue triage,
  no dashboards, and no RAG/vector search.
- The PR review is a learning aid, not a correctness guarantee. Review
  the diff yourself for anything security-critical.
- LLM summaries depend on the configured provider being available; if it
  is unavailable, the comment degrades to a deterministic summary with
  an explicit note.

## Architecture

See `docs/architecture.md` for the module map and request flow and
`docs/design-decisions.md` for the rationale behind the stack and
deliberate exclusions.

## Development checks

```bash
npm run test       # vitest (Workers runtime)
npm run lint       # biome check (lint + format)
npm run typecheck  # tsc --noEmit (strict)
```

CI runs exactly these three plus `npm ci` on every push and PR — no real
GitHub or LLM API calls in CI, ever.

## License

MIT — see `LICENSE`.

## Screenshots

<!-- v0.1.0: add two screenshots after live verification --
     1. an onboarding report issue on a demo repo
     2. a `### RepoLens review` comment on a PR -->
