/**
 * Deterministic onboarding report (spec §8): builds the markdown report
 * from already-fetched, untrusted repo data and runs the full onboarding
 * job (fetch → analyze → optional LLM summary → open issue).
 *
 * Markdown escaping: every untrusted string that lands in the issue body
 * is escaped so repo content cannot inject markdown into the report. The
 * LLM summary (Phase 4) will be included inside a fenced block because it
 * is generated content, not repo content. In Phase 3 no LLM call exists;
 * `summary: llm` degrades to deterministic-only with an explicit note
 * (spec §11, §13).
 */

import { loadRepolensConfig } from '../config/repolens-yml'
import type { Env } from '../env'
import { createOnboardingIssue } from '../github/issues'
import {
  fetchFileContents,
  fetchRepoMetadata,
  fetchRootTree,
} from '../github/repos'
import {
  analyzeManifests,
  detectLicenseFile,
  type ManifestAnalysis,
} from './manifests'

const IGNORED_ROOT_DIRS = new Set(['node_modules', 'dist', 'build', '.git'])

const MAX_ROOT_FILES_SHOWN = 20

export type OnboardingJobInput = {
  installationId: number | string
  owner: string
  repo: string
}

export type OnboardingJobResult = {
  status: 'posted' | 'skipped'
  /** Issue number when posted. */
  issueNumber?: number
  /** Why skipped — fixed safe strings only (never repo content). */
  reason?: 'onboarding-disabled'
}

/* ---------- data collection ---------- */

export type OnboardingData = {
  metadata: {
    name: string
    fullName: string
    description: string | null
    defaultBranch: string
    sizeKb: number
    language: string | null
    isPrivate: boolean
  }
  tree: { directories: string[]; files: string[] }
  manifests: ManifestAnalysis
  licenseFile: string | null
  /** Raw `.repolens.yml` text, or undefined when absent/too large. */
  configFileContent: string | undefined
}

export async function collectOnboardingData(
  env: Env,
  input: OnboardingJobInput,
  fetchImpl: typeof fetch = fetch,
): Promise<OnboardingData> {
  const { installationId, owner, repo } = input
  const metadata = await fetchRepoMetadata(
    env,
    installationId,
    owner,
    repo,
    fetchImpl,
  )
  const tree = await fetchRootTree(
    env,
    installationId,
    owner,
    repo,
    metadata.defaultBranch,
    fetchImpl,
  )

  const manifestPaths = [
    'package.json',
    'tsconfig.json',
    'requirements.txt',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'composer.json',
    'Gemfile',
  ].filter((path) => tree.files.includes(path))

  const wanted = [...manifestPaths, '.repolens.yml']
  const licenseInTree = tree.files.find((path) =>
    path.toUpperCase().startsWith('LICENSE'),
  )
  if (licenseInTree !== undefined && !wanted.includes(licenseInTree)) {
    wanted.push(licenseInTree)
  }

  const contents = await fetchFileContents(
    env,
    installationId,
    owner,
    repo,
    metadata.defaultBranch,
    wanted,
    fetchImpl,
  )

  return {
    metadata,
    tree,
    manifests: analyzeManifests(contents.files),
    licenseFile: detectLicenseFile(tree.files),
    configFileContent: contents.files['.repolens.yml'],
  }
}

/* ---------- report builder ---------- */

export type ReportInput = {
  metadata: OnboardingData['metadata']
  tree: OnboardingData['tree']
  manifests: ManifestAnalysis
  licenseFile: string | null
  /** From `.repolens.yml` parse; null when the file is present and valid. */
  configNote: string | null
  /** Generated LLM summary paragraph; null = none (deterministic only). */
  llmSummary: string | null
  /** Fixed degradation note (e.g. Phase 4 pending); null = none. */
  llmNote: string | null
}

/**
 * Builds the deterministic onboarding report markdown. All untrusted
 * repo-derived strings are escaped; notes are fixed strings chosen by
 * RepoLens, never repo content.
 */
export function buildOnboardingReport(data: ReportInput): string {
  const lines: string[] = []
  const push = (...items: string[]) => lines.push(...items)

  push('# RepoLens onboarding report', '')

  push('## Repository', '')
  push(`- Name: ${escapeInline(data.metadata.name)}`)
  push(
    `- Full name: ${escapeInline(data.metadata.fullName)}${data.metadata.isPrivate ? ' (private)' : ''}`,
  )
  push(
    `- Description: ${data.metadata.description === null ? '_not set_' : escapeInline(data.metadata.description)}`,
  )
  push(`- Default branch: ${escapeInline(data.metadata.defaultBranch)}`)
  push(`- Size: ~${data.metadata.sizeKb} KB`)
  push(
    `- Primary language (GitHub): ${data.metadata.language === null ? '_not set_' : escapeInline(data.metadata.language)}`,
  )
  push(
    `- Primary language (manifests): ${data.manifests.primaryLanguage === null ? '_(none detected)_' : escapeInline(data.manifests.primaryLanguage)}`,
  )
  push('')

  push('## Manifests detected', '')
  if (data.manifests.detected.length === 0) {
    push('_No recognized manifests at the repository root._')
  } else {
    push('| Manifest | Language | Dependencies |')
    push('|---|---|---|')
    for (const manifest of data.manifests.detected) {
      const deps =
        manifest.dependencyCount === null
          ? 'n/a'
          : String(manifest.dependencyCount)
      push(
        `| \`${escapeInline(manifest.path)}\` | ${escapeInline(manifest.language)} | ${deps} |`,
      )
    }
  }
  push('')

  if (data.manifests.npmScripts.length > 0) {
    push('## npm scripts', '')
    push(
      data.manifests.npmScripts
        .map((script) => `\`${escapeInline(script)}\``)
        .join(', '),
    )
    push('')
  }

  push('## Top-level structure', '')
  const directories = data.tree.directories.filter(
    (dir) => !IGNORED_ROOT_DIRS.has(dir),
  )
  const files = data.tree.files.filter((file) => {
    const firstSegment = file.split('/')[0]
    return !IGNORED_ROOT_DIRS.has(firstSegment)
  })
  if (directories.length === 0 && files.length === 0) {
    push('_Repository root is empty._')
  } else {
    if (directories.length > 0) {
      push(
        `**Directories (${directories.length}):** ${directories.map((dir) => `\`${escapeInline(dir)}\``).join(', ')}`,
      )
    }
    if (files.length > 0) {
      const shown = files.slice(0, MAX_ROOT_FILES_SHOWN)
      push(
        `**Files (${files.length}):** ${shown.map((file) => `\`${escapeInline(file)}\``).join(', ')}`,
      )
      if (files.length > MAX_ROOT_FILES_SHOWN) {
        push(`_…and ${files.length - MAX_ROOT_FILES_SHOWN} more._`)
      }
    }
  }
  push('')

  push('## License', '')
  push(
    data.licenseFile === null
      ? 'No license file detected at the repository root.'
      : `A license file is present: \`${escapeInline(data.licenseFile)}\`.`,
  )
  push('')

  if (data.configNote !== null) {
    push(`> ${data.configNote}`, '')
  }

  if (data.llmSummary !== null) {
    push('## Plain-language summary', '')
    push('```')
    push(data.llmSummary)
    push('```', '')
  }

  if (data.llmNote !== null) {
    push(`> ${data.llmNote}`, '')
  }

  push('---', '')
  push(
    '_Automated report by RepoLens — deterministic analysis of repository metadata only; no repository content was sent anywhere. Configure via `.repolens.yml` (see README). This is an automated learning aid; verify before acting._',
  )

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

function escapeInline(text: string): string {
  return escapeMarkdown(text)
}

/* ---------- job runner ---------- */

/**
 * Runs the full onboarding job for one newly-accessible repository:
 * metadata + tree + manifest contents → config → deterministic report →
 * (Phase 4: optional LLM summary) → open the report issue.
 *
 * GitHub API errors propagate to the caller (spec §13: retry, then post
 * nothing — never a broken half-report). Config errors degrade to
 * defaults plus a note in the report (spec §13).
 */
export async function runOnboardingJob(
  env: Env,
  input: OnboardingJobInput,
  fetchImpl: typeof fetch = fetch,
): Promise<OnboardingJobResult> {
  const data = await collectOnboardingData(env, input, fetchImpl)

  const loaded = loadRepolensConfig(data.configFileContent)
  if (!loaded.config.onboarding.enabled) {
    return { status: 'skipped', reason: 'onboarding-disabled' }
  }

  const report = buildOnboardingReport({
    metadata: data.metadata,
    tree: data.tree,
    manifests: data.manifests,
    licenseFile: data.licenseFile,
    configNote: loaded.note,
    llmSummary: null,
    llmNote:
      loaded.config.onboarding.summary === 'llm'
        ? 'note: LLM summaries are not enabled in this build — posting the deterministic report only.'
        : null,
  })

  const issueNumber = await createOnboardingIssue(
    env,
    input.installationId,
    input.owner,
    input.repo,
    report,
    fetchImpl,
  )
  return { status: 'posted', issueNumber }
}
