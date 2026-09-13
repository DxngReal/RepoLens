/**
 * GitHub repository content helpers (spec §5, §8): repo metadata, root
 * tree, and individual file contents, fetched with an installation token.
 *
 * `fetchImpl` is injectable so tests mock all GitHub calls (hard rule:
 * no real GitHub API calls in tests/CI). Errors are thrown as typed
 * `GitHubApiError` with status-only messages — response bodies are never
 * logged or embedded (could echo untrusted content, spec §13).
 */

import type { Env } from '../env'
import { GitHubError } from '../errors'
import { fetchWithRetry } from '../util/retry'
import { getInstallationToken } from './auth'

const GH_API_BASE = 'https://api.github.com'
const USER_AGENT = 'repolens'
const API_VERSION = '2022-11-28'

/** Non-retryable failures (4xx apart from 429); message has status only. */
export class GitHubApiError extends GitHubError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'GitHubApiError'
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

export type RepoMetadata = {
  name: string
  fullName: string
  description: string | null
  defaultBranch: string
  /** Repo size in KB as reported by GitHub. */
  sizeKb: number
  language: string | null
  isPrivate: boolean
}

type RepoApiResponse = {
  name?: unknown
  full_name?: unknown
  description?: unknown
  default_branch?: unknown
  size?: unknown
  language?: unknown
  private?: unknown
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new GitHubApiError(0, `repo response field '${field}' missing`)
  }
  return value
}

export async function fetchRepoMetadata(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoMetadata> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const response = await fetchWithRetry(
    fetchImpl,
    `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers: authHeaders(token) },
  )
  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      `repo metadata request failed with status ${response.status}`,
    )
  }
  const data = (await response.json()) as RepoApiResponse
  const defaultBranch = expectString(data.default_branch, 'default_branch')
  return {
    name: expectString(data.name, 'name'),
    fullName: expectString(data.full_name, 'full_name'),
    description: typeof data.description === 'string' ? data.description : null,
    defaultBranch,
    sizeKb: typeof data.size === 'number' ? data.size : 0,
    language: typeof data.language === 'string' ? data.language : null,
    isPrivate: data.private === true,
  }
}

/* ---------- tree ---------- */

export type RootTree = {
  /** Root-level paths, directories first then files, both sorted. */
  directories: string[]
  files: string[]
}

type GitTreeApiResponse = {
  tree?: {
    path?: unknown
    type?: unknown
  }[]
  truncated?: unknown
}

/**
 * Fetches the repo tree for a branch and reduces it to root-level
 * entries. Empty tree (never-pushed repo) yields empty lists.
 */
export async function fetchRootTree(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RootTree> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const response = await fetchWithRetry(
    fetchImpl,
    `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=0`,
    { headers: authHeaders(token) },
  )
  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      `tree request failed with status ${response.status}`,
    )
  }
  const data = (await response.json()) as GitTreeApiResponse
  if (data.truncated === true) {
    throw new GitHubApiError(0, 'tree response truncated')
  }
  const directories: string[] = []
  const files: string[] = []
  for (const entry of data.tree ?? []) {
    if (typeof entry.path !== 'string' || typeof entry.type !== 'string') {
      continue
    }
    if (entry.path.includes('/')) continue // root-level only
    if (entry.type === 'tree') directories.push(entry.path)
    if (entry.type === 'blob') files.push(entry.path)
  }
  directories.sort()
  files.sort()
  return { directories, files }
}

/* ---------- file contents ---------- */

export type FileContents = {
  /** Root-relative path → UTF-8 text (base64-decoded). */
  files: Record<string, string>
  /** Paths skipped because the blob was too large (logged count only). */
  oversizedPaths: string[]
}

const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const MAX_FILES = 32

/**
 * Fetches the given files' contents (base64 blobs) with per-file and
 * total caps. Oversized files are skipped, not fatal. `paths` must be
 * root-relative; the GitHub contents API only serves files ≤1MB and
 * RepoLens applies a stricter 256KB cap for analysis.
 */
export async function fetchFileContents(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  ref: string,
  paths: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<FileContents> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const files: Record<string, string> = {}
  const oversizedPaths: string[] = []
  let totalBytes = 0

  for (const path of paths.slice(0, MAX_FILES)) {
    const url = `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${encodeURIComponent(ref)}`
    let response: Response
    try {
      response = await fetchWithRetry(fetchImpl, url, {
        headers: authHeaders(token),
      })
    } catch {
      // Network-level failure: skip this file, keep going (spec §13).
      oversizedPaths.push(path)
      continue
    }
    if (response.status === 404) continue // vanished between calls
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `contents request failed with status ${response.status}`,
      )
    }
    const data = (await response.json()) as {
      content?: unknown
      encoding?: unknown
      size?: unknown
    }
    if (
      typeof data.content !== 'string' ||
      typeof data.size !== 'number' ||
      data.size > MAX_FILE_BYTES
    ) {
      oversizedPaths.push(path)
      continue
    }
    const bytes = base64ToBytes(data.content.replaceAll('\n', ''))
    if (
      bytes.length > MAX_FILE_BYTES ||
      totalBytes + bytes.length > MAX_TOTAL_BYTES
    ) {
      oversizedPaths.push(path)
      continue
    }
    totalBytes += bytes.length
    try {
      files[path] = new TextDecoder('utf-8', {
        fatal: false,
        ignoreBOM: false,
      }).decode(bytes)
    } catch {
      oversizedPaths.push(path)
    }
  }
  return { files, oversizedPaths }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
