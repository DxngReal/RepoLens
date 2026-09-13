# RepoLens

A GitHub App that helps people understand unfamiliar repositories and
review pull requests more quickly. On install it opens an onboarding
report issue; on each pull request it posts one summary review comment.
Deterministic analysis first; LLM summaries second; everything
configurable via `.repolens.yml`.

**Status: v0.1.0 in active development — Phase 1 (Foundation) complete.**
See `PROGRESS.md` for the live milestone tracker and
`docs/MASTER_BUILD_PROMPT.md` for the authoritative specification.

## Stack

- Cloudflare Workers + Hono + TypeScript (strict)
- Octokit (no Probot) — GitHub App auth: JWT → installation tokens
- Cloudflare Queues (async) + KV (idempotency/cache)
- Gemini Flash behind an `LLMProvider` interface (free tier)
- Vitest (Workers pool) + Biome; wrangler + smee.io for local dev

## Local development

```bash
npm install
npm run dev        # wrangler dev on http://127.0.0.1:8787
```

- `GET /healthz` — liveness probe
- `POST /webhook` — GitHub webhook receiver (stub in Phase 1)

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

## Development checks

```bash
npm run test       # vitest (Workers runtime)
npm run lint       # biome check (lint + format)
npm run typecheck  # tsc --noEmit (strict)
```

## Privacy

RepoLens sends repository content (diffs, file excerpts) to its
configured LLM provider (Google Gemini Flash) when LLM features are
enabled. Deterministic features never send content anywhere. You can
disable LLM usage per-repo via `.repolens.yml` (`onboarding.summary:
deterministic`, `review.enabled: false`). Every bot comment discloses
exactly this. Full disclosure: docs/MASTER_BUILD_PROMPT.md §11.

## License

MIT — see `LICENSE`.
