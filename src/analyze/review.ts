/**
 * PR review job (spec §9): fetch PR metadata + files → filter with
 * budgets → LLM summary (or deterministic degrade) → post exactly ONE
 * review comment per delivery.
 *
 * Honest-output rules (spec §2, §9, §11):
 * - Empty diff or every file filtered out → post nothing.
 * - LLM failure/timeout → deterministic-only comment with an explicit
 *   note (degrade, never fake). Config `review.enabled: false` → skip.
 * - The comment body escapes untrusted metadata; LLM output is sanitized
 *   (trailing content after our end marker removed) and length-capped.
 * - Errors propagate to the caller for retry/logging; we never post a
 *   broken half-review.
 */

import {
  type ConfigParseResult,
  loadRepolensConfig,
} from '../config/repolens-yml'
import type { Env } from '../env'
import { createPrReviewComment } from '../github/issues'
import { fetchPrFiles, fetchPrMetadata } from '../github/pulls'
import { fetchFileContents } from '../github/repos'
import {
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  type LLMProvider,
  REVIEW_END_MARKER,
  REVIEW_REQUIRED_HEADINGS,
} from '../llm/provider'
import { buildDiffContext, selectFilesForReview } from './diff'

const REVIEW_HEADING = '### RepoLens review'

export type ReviewJobInput = {
  installationId: number | string
  owner: string
  repo: string
  number: number
}

export type ReviewJobResult = {
  status: 'posted' | 'skipped'
  /** Comment id when posted. */
  commentId?: number
  /** Why skipped — fixed safe strings only (never repo content). */
  reason?: 'review-disabled' | 'empty-diff' | 'all-files-filtered' | 'draft-pr'
  /** When the LLM failed and we degraded to deterministic output. */
  degraded?: boolean
}

/* ---------- output sanitizing ---------- */

const END_MARKER = REVIEW_END_MARKER

/**
 * Mechanical output verification (spec §13, output contract): the model
 * must echo the exact end marker and all required headings, in order.
 * False → the job degrades to deterministic output; malformed or
 * injection-influenced output is never posted. Deliberate ceiling
 * (Ponytail): structure checks only — semantic correctness of review
 * prose is not verifiable.
 */
export function verifyReviewOutput(raw: string): boolean {
  if (!raw.includes(END_MARKER)) return false
  const body = raw.slice(0, raw.indexOf(END_MARKER))
  let cursor = 0
  for (const heading of REVIEW_REQUIRED_HEADINGS) {
    const found = body.indexOf(heading, cursor)
    if (found < 0) return false
    cursor = found + heading.length
  }
  return true
}

/** Hard cap on the LLM-generated section of the comment. */
const MAX_REVIEW_SUMMARY_CHARS = 6000

/**
 * Normalizes LLM output: strips trailing content after the end marker
 * (prompt-injection containment), removes a possible repeated heading,
 * and hard-caps length. Repo-influenced text → rendered as the summary
 * section of our comment template.
 */
export function sanitizeReviewOutput(raw: string): string {
  const markerIndex = raw.indexOf(END_MARKER)
  const body = markerIndex >= 0 ? raw.slice(0, markerIndex) : raw
  const headingPattern = new RegExp(
    `^#{1,6}\\s*${REVIEW_HEADING.replace(/([^\w\s])/g, '\\$1')}`,
  )
  const withoutHeading = body.replace(headingPattern, '').trim()
  if (withoutHeading.length <= MAX_REVIEW_SUMMARY_CHARS) {
    return withoutHeading
  }
  return `${withoutHeading.slice(0, MAX_REVIEW_SUMMARY_CHARS)}\n…(truncated)`
}

/* ---------- deterministic fallback ---------- */

/**
 * Builds the deterministic fallback summary used when the LLM is
 * disabled, unavailable, or failed: purely mechanical facts, honestly
 * labeled. Never invents anything (spec §2, §11).
 */
export function buildDeterministicReview(
  metadata: {
    title: string
    additions: number
    deletions: number
    changedFiles: number
  },
  selection: { includedCount: number; usedLines: number; skippedCount: number },
): string {
  const lines: string[] = []
  lines.push('### Summary')
  lines.push(
    `Automated deterministic summary (LLM summary unavailable): the PR touches ${metadata.changedFiles} file(s) with ${metadata.additions} addition(s) and ${metadata.deletions} deletion(s). ${selection.includedCount} file(s) were included in analysis (${selection.usedLines} changed lines).`,
  )
  lines.push('### Risks / things to check')
  lines.push(
    '- Not evaluated in this run (deterministic fallback only); review the diff manually.',
  )
  lines.push('### Suggestions')
  lines.push('- None (deterministic fallback).')
  return lines.join('\n')
}

/* ---------- job runner ---------- */

export type ReviewJobDeps = {
  /** LLM provider; omit to run deterministic-only. */
  provider?: LLMProvider
  fetchImpl?: typeof fetch
}

/**
 * Fetches `.repolens.yml` from the base branch for review config.
 * Missing file → defaults without note; errors other than 404 propagate
 * (spec §13).
 */
async function fetchReviewConfig(
  env: Env,
  input: ReviewJobInput,
  baseRef: string,
  fetchImpl: typeof fetch,
): Promise<ConfigParseResult> {
  const contents = await fetchFileContents(
    env,
    input.installationId,
    input.owner,
    input.repo,
    baseRef,
    ['.repolens.yml'],
    fetchImpl,
  )
  return loadRepolensConfig(contents.files['.repolens.yml'])
}

/**
 * Runs the full review job for one PR. GitHub API errors propagate to
 * the caller (spec §13: retry, then post nothing). Never posts when the
 * diff is empty or fully filtered (spec §9).
 */
export async function runReviewJob(
  env: Env,
  input: ReviewJobInput,
  deps: ReviewJobDeps = {},
): Promise<ReviewJobResult> {
  const fetchImpl = deps.fetchImpl ?? fetch

  // 1. Metadata (needed for config location + honesty fields).
  const metadata = await fetchPrMetadata(
    env,
    input.installationId,
    input.owner,
    input.repo,
    input.number,
    fetchImpl,
  )
  if (metadata.isDraft) {
    return { status: 'skipped', reason: 'draft-pr' }
  }

  // 2. `.repolens.yml` from the base branch (review config source).
  const configResult = await fetchReviewConfig(
    env,
    input,
    metadata.baseRef,
    fetchImpl,
  )
  if (!configResult.config.review.enabled) {
    return { status: 'skipped', reason: 'review-disabled' }
  }

  // 3. Files + filters/budgets (spec §9 step 2).
  const files = await fetchPrFiles(
    env,
    input.installationId,
    input.owner,
    input.repo,
    input.number,
    fetchImpl,
  )
  const selection = selectFilesForReview(
    files,
    {
      maxDiffLines: configResult.config.review.maxDiffLines,
      maxFileLines: configResult.config.review.maxFileLines,
    },
    configResult.config.exclude,
  )

  if (files.length === 0) {
    return { status: 'skipped', reason: 'empty-diff' }
  }
  if (selection.included.length === 0) {
    return { status: 'skipped', reason: 'all-files-filtered' }
  }

  // 4. LLM summary (one call max, spec §14) or deterministic degrade.
  const diffContext = buildDiffContext(selection)
  let summary: string
  let degraded = false
  const provider = deps.provider
  if (provider !== undefined) {
    try {
      const prompt = buildReviewUserPrompt({
        prTitle: metadata.title,
        prBody: metadata.body,
        repoFullName: `${input.owner}/${input.repo}`,
        prNumber: input.number,
        authorLogin: metadata.authorLogin,
        headRef: metadata.headRef,
        baseRef: metadata.baseRef,
        diffContext,
        skippedFiles: selection.skipped.map((s) => s.filename),
      })
      const raw = await provider.complete(
        `${buildReviewSystemPrompt()}\n\n${prompt}`,
      )
      if (!verifyReviewOutput(raw)) {
        // Output contract violated → discard entirely, never post
        // malformed or injection-influenced output (spec §13). The catch
        // below degrades to the deterministic fallback.
        throw new Error('review output failed the output contract')
      }
      summary = sanitizeReviewOutput(raw)
    } catch {
      // Degrade gracefully with an explicit note (spec §11, §13).
      degraded = true
      summary = buildDeterministicReview(
        {
          title: metadata.title,
          additions: metadata.additions,
          deletions: metadata.deletions,
          changedFiles: metadata.changedFiles,
        },
        {
          includedCount: selection.included.length,
          usedLines: selection.usedLines,
          skippedCount: selection.skipped.length,
        },
      )
    }
  } else {
    summary = buildDeterministicReview(
      {
        title: metadata.title,
        additions: metadata.additions,
        deletions: metadata.deletions,
        changedFiles: metadata.changedFiles,
      },
      {
        includedCount: selection.included.length,
        usedLines: selection.usedLines,
        skippedCount: selection.skipped.length,
      },
    )
  }

  // 5. Post exactly one comment (spec §9).
  const commentId = await createPrReviewComment(
    env,
    input.installationId,
    input.owner,
    input.repo,
    input.number,
    buildReviewCommentBody({
      summary,
      degraded,
      skipped: selection.skipped,
      includeLlmDisclosure: provider !== undefined && !degraded,
    }),
    fetchImpl,
  )
  return { status: 'posted', commentId, degraded }
}

/* ---------- comment body ---------- */

export type ReviewCommentParts = {
  summary: string
  degraded: boolean
  skipped: { filename: string; reason: string }[]
  includeLlmDisclosure: boolean
}

/** Fixed footer, honest about what was sent to the LLM (spec §11). */
export function buildReviewFooter(includeLlmDisclosure: boolean): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(
    '_Automated comment by RepoLens, a learning aid — not a guarantee of correctness.',
  )
  if (includeLlmDisclosure) {
    lines.push(
      ' The filtered diff and PR metadata above were sent to an LLM provider (Gemini Flash) to generate the summary.',
    )
  } else {
    lines.push(
      ' No repository content was sent to any LLM provider for this comment.',
    )
  }
  lines.push(' Configure or disable via `.repolens.yml` (see README)._')
  return lines.join('')
}

/** Assembles the final comment body with escaped metadata. */
export function buildReviewCommentBody(parts: ReviewCommentParts): string {
  const lines: string[] = []
  lines.push(REVIEW_HEADING)
  lines.push('')
  lines.push(parts.summary)
  if (parts.skipped.length > 0) {
    lines.push('')
    lines.push(
      `> note: ${parts.skipped.length} file(s) excluded by filters/budgets: ` +
        parts.skipped
          .slice(0, 10)
          .map((s) => `\`${escapeMarkdown(s.filename)}\` (${s.reason})`)
          .join(', ') +
        (parts.skipped.length > 10
          ? `, and ${parts.skipped.length - 10} more`
          : ''),
    )
  }
  lines.push('')
  lines.push(buildReviewFooter(parts.includeLlmDisclosure))
  return lines.join('\n')
}

function escapeMarkdown(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('<', '\\<')
    .replaceAll('>', '\\>')
    .replaceAll('#', '\\#')
    .replaceAll('!', '\\!')
    .replaceAll('@', '\\@')
}
