/**
 * GitHub issues helper (spec §5, §8, §9): creates the onboarding report
 * issue and the single PR review comment.
 *
 * `fetchImpl` is injectable so tests mock all GitHub calls (hard rule).
 * Error messages carry status only — response bodies are never logged or
 * embedded (spec §13). Bodies are built by the caller; this module only
 * performs the API calls and normalizes the failure surface.
 */

import type { Env } from '../env'
import { GitHubError } from '../errors'
import { fetchWithRetry } from '../util/retry'
import { getInstallationToken } from './auth'

const GH_API_BASE = 'https://api.github.com'
const USER_AGENT = 'repolens'
const API_VERSION = '2022-11-28'

export class GitHubIssueError extends GitHubError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'GitHubIssueError'
  }
}

const ONBOARDING_ISSUE_TITLE = 'RepoLens onboarding report'

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  }
}

/** Shared POST: returns the parsed JSON object or throws status-only. */
async function postJson(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  path: string,
  payload: Record<string, string>,
  fetchImpl: typeof fetch,
  label: string,
): Promise<Record<string, unknown>> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const response = await fetchWithRetry(
    fetchImpl,
    `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  )
  if (!response.ok) {
    throw new GitHubIssueError(
      response.status,
      `${label} request failed with status ${response.status}`,
    )
  }
  const data = (await response.json()) as Record<string, unknown>
  return typeof data === 'object' && data !== null ? data : {}
}

/**
 * Creates the onboarding report issue. Returns the issue number.
 */
export async function createOnboardingIssue(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const data = await postJson(
    env,
    installationId,
    owner,
    repo,
    'issues',
    { title: ONBOARDING_ISSUE_TITLE, body },
    fetchImpl,
    'create issue',
  )
  if (typeof data.number !== 'number') {
    throw new GitHubIssueError(0, 'create issue response missing number')
  }
  return data.number
}

/**
 * Creates the single PR review comment. Returns the comment id.
 * Exactly one comment per delivery is the caller's responsibility
 * (dedupe happens at the webhook layer, spec §5, §9).
 */
export async function createPrReviewComment(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  number: number,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const data = await postJson(
    env,
    installationId,
    owner,
    repo,
    `issues/${number}/comments`,
    { body },
    fetchImpl,
    'create review comment',
  )
  if (typeof data.id !== 'number') {
    throw new GitHubIssueError(0, 'create review comment response missing id')
  }
  return data.id
}
