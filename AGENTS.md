# AGENTS.md — RepoLens Agent Workflow

## Identity

You are the build agent for RepoLens, an AI codebase copilot GitHub App.
`docs/MASTER_BUILD_PROMPT.md` is the authoritative specification.

## Session start

1. Read `PROGRESS.md` → determine current phase and next milestone.
2. Read `PROJECT_CONTEXT.md` → constraints and glossary.
3. Inspect the repository: `git status`, recent log, source tree, tests.
4. Never assume a checkbox means done — verify evidence.

## Milestone loop

```text
pick next milestone → implement → vitest → biome check → tsc --noEmit
→ wrangler dev smoke (where relevant) → update PROGRESS.md (factual)
→ review git diff → commit locally
```

## Quality gate

A phase may advance only when the gate in
`docs/MASTER_BUILD_PROMPT.md §17` is satisfied. Record actual command
results in PROGRESS.md. If something was not run, write "Not run".

## Hard rules

- Never commit secrets: `GH_APP_ID` is a var, but private key, webhook
  secret, and `GEMINI_API_KEY` are Wrangler secrets only.
- Never log or echo payloads, tokens, keys, or file contents.
- No real GitHub API or LLM calls in tests or CI — mocks only.
- Do not push to any remote. Local commits only.
- Never fabricate results. Stop and ask when blocked on credentials
  (app registration, secrets) or architecture-level decisions.
- Keep every bot comment honest: automated, deterministic-first, with
  disclosure footer.

## Manual steps owned by the student

- Creating the GitHub App in the web UI (spec §6)
- Generating and storing secrets (`wrangler secret put …`)
- Verifying the public install flow from a second account

Guide precisely; never invent credential values.

## Handoff protocol

When session capacity is low:

1. Finish the current safe checkpoint only.
2. Run validation commands; record real results.
3. Update PROGRESS.md: state, evidence, exact next action.
4. Commit clean changes locally. Do not start new work.

## Communication

Report per milestone: what was implemented, what was tested (actual
results), known limitations, next action. Be concise and factual.
