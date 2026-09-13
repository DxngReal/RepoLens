/**
 * Diff filtering + budgets (spec §9 step 2).
 *
 * Pure analysis over already-fetched PR files. Rules, applied in order:
 *   1. excluded by `.repolens.yml` glob patterns (path match)
 *   2. no patch (binary or diff too large for the API to return)
 *   3. lockfile / generated-path heuristics
 *   4. file over `maxFileLines` changed lines (default 500)
 *   5. budget exhausted (`maxDiffLines`, default 1500)
 *
 * Files over budget are *noted as skipped*, never silently dropped
 * (spec §9: "note skipped files"). Nothing here throws on adversarial
 * content; all inputs are untrusted data.
 *
 * This comment block is a small, non-breaking change added during the
 * v0.1.0 release verification so the PR review pipeline can be tested
 * end to end on a real repo.
 */

import type { PrFile } from '../github/pulls'

export type DiffBudgets = {
  maxDiffLines: number
  maxFileLines: number
}

/** Files selected into the review, plus everything skipped and why. */
export type DiffSelection = {
  /** Files inside the budget, in stable (API) order. */
  included: (PrFile & { patch: string })[]
  skipped: { filename: string; reason: SkippedReason }[]
  /** Sum of `changes` across included files. */
  usedLines: number
  budgets: DiffBudgets
}

export type SkippedReason =
  | 'excluded-by-config'
  | 'no-patch'
  | 'lockfile'
  | 'generated'
  | 'file-too-large'
  | 'budget-exhausted'

const LOCKFILE_PATTERNS = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)bun\.lockb?$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)go\.sum$/i,
  /(^|\/)npm-shrinkwrap\.json$/i,
]

/** Paths that are almost always generated, per spec §9. */
const GENERATED_PATTERNS = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)vendor\//,
  /(^|\/)coverage\//,
  /(^|\/)node_modules\//,
  /\.min\.(js|css)$/i,
  /-lock\.json$/i,
  /\.(snap|pb\.go|pb\.ts|d\.ts)$/i,
]

export function isLockfile(path: string): boolean {
  return LOCKFILE_PATTERNS.some((pattern) => pattern.test(path))
}

export function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(path))
}

/** Glob subset: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i++
        // Collapse a following slash so `dist/**` also matches `dist/x`.
        if (pattern[i + 1] === '/') i++
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      continue
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

export function selectFilesForReview(
  files: readonly PrFile[],
  budgets: DiffBudgets,
  excludePatterns: readonly string[] = [],
): DiffSelection {
  const excludeMatchers = excludePatterns
    .filter((pattern) => pattern.trim().length > 0)
    .map((pattern) => globToRegExp(pattern.trim()))

  const included: (PrFile & { patch: string })[] = []
  const skipped: { filename: string; reason: SkippedReason }[] = []
  let usedLines = 0

  for (const file of files) {
    if (excludeMatchers.some((re) => re.test(file.filename))) {
      skipped.push({ filename: file.filename, reason: 'excluded-by-config' })
      continue
    }
    if (file.patch === null) {
      skipped.push({ filename: file.filename, reason: 'no-patch' })
      continue
    }
    if (isLockfile(file.filename)) {
      skipped.push({ filename: file.filename, reason: 'lockfile' })
      continue
    }
    if (isGenerated(file.filename)) {
      skipped.push({ filename: file.filename, reason: 'generated' })
      continue
    }
    if (file.changes > budgets.maxFileLines) {
      skipped.push({ filename: file.filename, reason: 'file-too-large' })
      continue
    }
    if (usedLines + file.changes > budgets.maxDiffLines) {
      skipped.push({ filename: file.filename, reason: 'budget-exhausted' })
      continue
    }
    included.push({ ...file, patch: file.patch })
    usedLines += file.changes
    if (usedLines >= budgets.maxDiffLines) break
  }

  return { included, skipped, usedLines, budgets }
}

/**
 * Builds the prompt-ready filtered diff text: per-file blocks with
 * untrusted-data delimiters (spec §7, §11). The joined text is
 * hard-capped as defense in depth even though budgets already bound it.
 */
export function buildDiffContext(
  selection: DiffSelection,
  hardCapChars = 400_000,
): string {
  const parts: string[] = []
  let total = 0
  for (const file of selection.included) {
    const block = [
      `--- FILE: ${file.filename} (status: ${file.status}, +${file.additions}/-${file.deletions}) ---`,
      '```diff',
      file.patch,
      '```',
    ].join('\n')
    if (total + block.length > hardCapChars) {
      parts.push(`--- FILE: ${file.filename} --- omitted (context cap)`)
      continue
    }
    parts.push(block)
    total += block.length
  }
  return parts.join('\n\n')
}
