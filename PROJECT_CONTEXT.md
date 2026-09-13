# RepoLens — Project Context

## What & why

RepoLens is a GitHub App that helps people understand unfamiliar
repositories and review pull requests more quickly. On install it opens an
onboarding report issue; on each pull request it posts one summary review
comment. Deterministic analysis first; LLM summaries second; everything
configurable via `.repolens.yml`.

It is the 5th portfolio project of a first-year CS student, built with an
AI-agent engineering workflow (see AGENTS.md and PROGRESS.md).

## Portfolio context

| # | Project | Domain |
|---|---|---|
| 1 | DevVault | Electron desktop developer tool |
| 2 | MiniKV | Go systems: KV store, WAL, TTL |
| 3 | CampusHub API | FastAPI backend: auth, CRUD, deploy |
| 4 | CampusHub Web | Next.js fullstack frontend |
| 5 | RepoLens | **Event-driven cloud service: webhooks, GitHub App, LLM** |

New capability covered here: asynchronous event processing, webhook
security, installation-token auth, serverless deployment, LLM integration
with budgets and privacy controls.

## Stack summary

Cloudflare Workers + Hono + TypeScript strict; Octokit (no Probot);
Cloudflare Queues (async) + KV (idempotency/cache); Gemini Flash behind an
LLMProvider interface; Vitest + Biome; wrangler + smee for local dev.

## Constraints

- $0/month operating cost target (Workers/KV/Queues free tiers + free LLM)
- No secrets in code, git, logs, or bot comments
- No real GitHub/LLM calls in tests or CI
- Least-privilege GitHub App permissions (spec §6), nothing more
- Honest scope: onboarding + one-comment PR review only; everything else
  deferred to v0.2+ (see MASTER_BUILD_PROMPT §2)

## Glossary

- **GitHub App**: integration acting as its own bot identity with
  fine-grained permissions; installed per repo/org.
- **Installation token**: short-lived bearer token obtained by exchanging
  a signed JWT; used for all GitHub API calls.
- **Webhook HMAC**: SHA-256 signature of the payload with the app's
  webhook secret; must be verified before trusting any delivery.
- **Idempotency**: skipping duplicate webhook deliveries via their
  delivery id, so retries never cause double comments.
- **Token budget**: hard cap on diff/context size sent to the LLM.
- **Prompt injection**: instructions hidden in repo content trying to
  manipulate the LLM; content is always treated as untrusted data.
