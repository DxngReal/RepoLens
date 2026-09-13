/**
 * GitHub issues helper (spec §5, §8): creates the onboarding report issue.
 *
 * `fetchImpl` is injectable so tests mock all GitHub calls (hard rule).
 * Error messages carry status only — response bodies are never logged or
 * embedded (spec §13). The issue body is built by the caller; this module
 * only performs the API call and normalizes the failure surface.
 */

import type { Env } from '../env'
import { getInstallationToken } from './auth'

const GH_API_BASE = 'https://api.github.com'
const USER_AGENT = 'repolens'
const API_VERSION = '2022-11-28'

export class GitHubIssueError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubIssueError'
  }
}

const ONBOARDING_ISSUE_TITLE = 'RepoLens onboarding report'

/**
 * Creates the onboarding report issue. Returns the issue number.
 * Labels are best-effort: a label API failure does not fail the report.
 */
export async function createOnboardingIssue(
  env: Env,
  installationId: number | string,
  owner: string,
  repo: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const token = await getInstallationToken(env, installationId, fetchImpl)
  const response = await fetchImpl(
    `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: ONBOARDING_ISSUE_TITLE, body }),
    },
  )
  if (!response.ok) {
    throw new GitHubIssueError(
      response.status,
      `create issue request failed with status ${response.status}`,
    )
  }
  const data = (await response.json()) as { number?: unknown }
  if (typeof data.number !== 'number') {
    throw new GitHubIssueError(0, 'create issue response missing number')
  }
  return data.number
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  }
}
