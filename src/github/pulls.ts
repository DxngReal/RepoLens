/**
 * GitHub pull request helpers (spec §5, §9): PR metadata and the changed
 * files list, fetched with an installation token.
 *
 * `fetchImpl` is injectable so tests mock all GitHub calls (hard rule).
 * Error messages carry status only — response bodies are never logged or
 * embedded (spec §13). All returned fields are untrusted data (spec §3):
 * callers must treat them as such (delimit in prompts, escape in output).
 */

import type { Env } from '../env'
import { GitHubError } from '../errors'
import { fetchWithRetry } from '../util/retry'
import { getInstallationToken } from './auth'

const GH_API_BASE = 'https://api.github.com'
const USER_AGENT = 'repolens'
const API_VERSION = '2022-11-28'

/** Non-retryable failures (4xx apart from 429); message has status only. */
export class GitHubPullsError extends GitHubError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'GitHubPullsError'
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  }
}

/* ---------- PR metadata ---------- */

export type PrMetadata = {
  title: string
  body: string | null
  authorLogin: string | null
  headRef: string
  baseRef: string
  isDraft: boolean
  additions: number
  deletions: number
  changedFiles: number
}

type PullApiResponse = {
  title?: unknown
  body?: unknown
  draft?: unknown
  additions?: unknown
  deletions?: unknown
  changed_files?: unknown
  user?: { login?: unknown } | null
  head?: { ref?: unknown } | null
  base?: { ref?: unknown } | null
}

export async function fetchPrMetadata(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PrMetadata> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const response = await fetchWithRetry(
    fetchImpl,
    `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    { headers: authHeaders(token) },
  )
  if (!response.ok) {
    throw new GitHubPullsError(
      response.status,
      `pull request request failed with status ${response.status}`,
    )
  }
  const data = (await response.json()) as PullApiResponse
  return {
    title: typeof data.title === 'string' ? data.title : '',
    body: typeof data.body === 'string' ? data.body : null,
    authorLogin:
      data.user !== null &&
      data.user !== undefined &&
      typeof data.user.login === 'string'
        ? data.user.login
        : null,
    headRef: typeof data.head?.ref === 'string' ? data.head.ref : '',
    baseRef: typeof data.base?.ref === 'string' ? data.base.ref : '',
    isDraft: data.draft === true,
    additions: typeof data.additions === 'number' ? data.additions : 0,
    deletions: typeof data.deletions === 'number' ? data.deletions : 0,
    changedFiles:
      typeof data.changed_files === 'number' ? data.changed_files : 0,
  }
}

/* ---------- changed files ---------- */

export type PrFile = {
  filename: string
  /** added | removed | modified | renamed | changed (as reported). */
  status: string
  additions: number
  deletions: number
  /** additions + deletions as reported by GitHub. */
  changes: number
  /** Unified diff text; absent for binaries and files >~20k lines. */
  patch: string | null
}

type FilesApiResponse = {
  filename?: unknown
  status?: unknown
  additions?: unknown
  deletions?: unknown
  changes?: unknown
  patch?: unknown
}[]

/**
 * Fetches the PR changed files (Files API). GitHub caps the list at 300
 * files; we fetch up to 3 pages of 100 sequentially (no bursts, spec
 * §14). Files beyond the API cap are simply not visible here — the
 * review works on what the API returns.
 */
export async function fetchPrFiles(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PrFile[]> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const files: PrFile[] = []
  const MAX_PAGES = 3
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchWithRetry(
      fetchImpl,
      `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=100&page=${page}`,
      { headers: authHeaders(token) },
    )
    if (!response.ok) {
      throw new GitHubPullsError(
        response.status,
        `pull request files request failed with status ${response.status}`,
      )
    }
    const data = (await response.json()) as FilesApiResponse
    if (!Array.isArray(data)) {
      throw new GitHubPullsError(0, 'pull request files response is not a list')
    }
    for (const entry of data) {
      if (typeof entry.filename !== 'string') continue
      files.push({
        filename: entry.filename,
        status: typeof entry.status === 'string' ? entry.status : 'changed',
        additions: typeof entry.additions === 'number' ? entry.additions : 0,
        deletions: typeof entry.deletions === 'number' ? entry.deletions : 0,
        changes:
          typeof entry.changes === 'number'
            ? entry.changes
            : (typeof entry.additions === 'number' ? entry.additions : 0) +
              (typeof entry.deletions === 'number' ? entry.deletions : 0),
        patch: typeof entry.patch === 'string' ? entry.patch : null,
      })
    }
    if (data.length < 100) break
  }
  return files
}
