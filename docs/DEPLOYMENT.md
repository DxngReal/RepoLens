# RepoLens Deployment Runbook (v0.1.0)

Agent-side Phase 6 work is done (CI, README, dry-run pre-flight). The
steps below are the manual ones owned by the student. Nothing here
requires the agent; never paste secret values anywhere they could be
committed or echoed.

## 0. Prerequisites

- A Cloudflare account (free tier is sufficient)
- Node 22 + npm installed
- This repository cloned locally, working tree clean

## 1. Cloudflare login (once)

```bash
npx wrangler login
```

A browser window opens; approve the OAuth prompt. Verify with:

```bash
npx wrangler whoami
```

## 2. Create the KV namespace and record the real id

```bash
npx wrangler kv namespace create IDEMPOTENCY_KV
```

The command prints a namespace `id`. Edit `wrangler.jsonc` and replace
the placeholder:

```jsonc
"kv_namespaces": [
  { "binding": "IDEMPOTENCY_KV", "id": "<paste the printed id here>" }
]
```

(The empty preview_id warning can be ignored for a single-environment
project.)

## 3. Create the queues (both the job queue and the DLQ)

```bash
npx wrangler queues create repolens-jobs
npx wrangler queues create repolens-jobs-dlq
```

If a queue already exists the command says so — that is fine.

## 4. Deploy

```bash
npx wrangler deploy
```

Note the printed `https://repolens.<your-subdomain>.workers.dev` URL.

Smoke-test the public URL (all of these are expected):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://repolens.<your-subdomain>.workers.dev/healthz
# → 200

curl -s -o /dev/null -w "%{http_code}\n" -X POST https://repolens.<your-subdomain>.workers.dev/webhook
# → 401 (no signature header — fail-closed is correct)
```

## 5. Set secrets and the app-id var

Three secrets (values are never typed into any file):

```bash
npx wrangler secret put GH_PRIVATE_KEY     # paste the .pem contents
npx wrangler secret put GH_WEBHOOK_SECRET  # paste the webhook secret
npx wrangler secret put GEMINI_API_KEY     # paste the Gemini API key
```

One var: set `GH_APP_ID` in `wrangler.jsonc` `vars` (numeric App ID from
the GitHub App settings page) and re-run `npx wrangler deploy`.

## 6. GitHub App registration (spec §6 — full checklist in PROGRESS.md)

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
2. Webhook URL: `https://repolens.<your-subdomain>.workers.dev/webhook`
   (not smee.io — this is the production switch)
3. Webhook secret: a strong random value (`openssl rand -hex 32`); store
   it safely; you will also `wrangler secret put` it in step 5
4. Permissions (least privilege): Contents **Read-only**, Issues
   **Read & write**, Pull requests **Read & write**, Metadata **Read-only**
5. Subscribe to events: `installation`, `pull_request`
6. Where can this app be installed: **Any account**
7. Create, then **Generate a private key** (downloads a `.pem`)
8. Note the App ID and the client ID from the app settings page

If you already registered the app for local development: edit it, switch
the webhook URL to the Workers URL, and reuse the existing webhook secret
and private key for the secrets in step 5.

## 7. End-to-end verification

1. Install the app on a test repo from **a second GitHub account** (the
   public install link is on the app settings page:
   `https://github.com/apps/<app-name>/installations/new`).
2. Expected: one issue titled `RepoLens onboarding report` opens on the
   repo within seconds.
3. Open a PR on that repo. Expected: exactly one `### RepoLens review`
   comment with Summary / Risks / Suggestions and an honest footer.
4. Push another commit to the PR branch (`synchronize`): expected a new
   comment (no edits), still exactly one comment per delivery.
5. Configuration paths — add to the repo root:
   - `.repolens.yml` with `review.enabled: false` → next PR gets no
     RepoLens comment.
   - `.repolens.yml` with `onboarding.enabled: false` → a fresh install
     on a new repo posts no onboarding issue.
   - An intentionally invalid `.repolens.yml` → bot output includes a
     one-line config note, nothing crashes.
6. Re-check the Workers URL after the verification: `wrangler tail` shows
   safe single-line logs only (no payload text).

## 8. Release prep

- Tag: `git tag -a v0.1.0 -m "RepoLens v0.1.0"` (local; do not push)
- CI: verify the Actions tab shows a green run after the repo is on
  GitHub

## Troubleshooting

- **Deploy fails with a KV namespace error** → the placeholder id from
  local dev is still in `wrangler.jsonc`; redo step 2.
- **401 on signed deliveries in production** → `GH_WEBHOOK_SECRET`
  differs between the GitHub App settings and `wrangler secret put`.
- **`GEMINI_API_KEY` unset** → the worker stays healthy but reviews
  degrade to deterministic-only with an explicit note in the comment
  footer; onboarding reports are unaffected.
