# RepoLens — Development Log

Factual, chronological notes about incidents and fixes that affect how the
project is run or understood. This is not a changelog; release history lives
in git tags/commit history and README.

---

## 2026-09-13 — Production secret rotation

During initial production setup, the GitHub App ping delivery returned 401.
Root cause: the webhook secret in the GitHub App settings did not match the
value set with `wrangler secret put GH_WEBHOOK_SECRET`. Fixed by rotating the
secret on both ends (regenerate on the GitHub App page, set the matching value
in Wrangler) and forcing a redelivery. Lesson: treat the webhook secret as a
shared production secret and verify ping before anything else.

## 2026-09-13 — GitHub App permissions must be satisfied before first install

The app was first installed without the Contents permission. The onboarding
report needs Contents read to fetch the repo tree and manifests, so the first
install did not produce an onboarding issue. Fixed by adding the required
permission, then uninstalling and reinstalling to trigger a fresh
`installation.created` delivery (the old delivery id was already in the KV
idempotency window, so a redelivery would have been skipped). Lesson: verify
app permissions match the spec’s least-privilege list (Contents R/O, Issues RW,
Pull requests RW, Metadata R/O) before the first install.
