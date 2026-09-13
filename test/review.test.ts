import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { runReviewJob, sanitizeReviewOutput } from '../src/analyze/review'
import type { Env } from '../src/env'
import type { LLMProvider } from '../src/llm/provider'

/**
 * Phase 4 tests (spec §12): review job happy path, skip rules, honest
 * degrade, and output sanitizing — with a mocked GitHub fetch and a
 * mocked LLMProvider (hard rule: no real GitHub or LLM calls).
 */

async function generateTestPrivateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign'],
  )) as CryptoKeyPair
  const der = (await crypto.subtle.exportKey(
    'pkcs8',
    pair.privateKey,
  )) as ArrayBuffer
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)))
  const lines = base64.match(/.{1,64}/g)?.join('\n') ?? base64
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`
}

function envWithPrivateKey(privateKeyPem: string, geminiKey = ''): Env {
  return {
    ...(env as object),
    GH_APP_ID: '12345',
    GH_PRIVATE_KEY: privateKeyPem,
    GH_WEBHOOK_SECRET: 'test-webhook-secret',
    GEMINI_API_KEY: geminiKey,
  } as unknown as Env
}

type Route = {
  match: (path: string) => boolean
  body?: unknown
  status?: number
}

function mockGitHubFetch(routes: Route[]): {
  fetchImpl: typeof fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(url), init })
    const path = String(url)
      .replace(/^https:\/\/api\.github\.com/, '')
      .split('?')[0]
    if (
      path.startsWith('/app/installations/') &&
      path.endsWith('/access_tokens')
    ) {
      return new Response(
        JSON.stringify({
          token: 'mock-installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      )
    }
    const match = routes.find((route) => route.match(path))
    if (match === undefined) {
      throw new Error(`unexpected GitHub API call: ${path}`)
    }
    return new Response(JSON.stringify(match.body ?? {}), {
      status: match.status ?? 200,
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const PR_META = {
  title: 'Add login rate limiting',
  body: 'Limits repeated failed logins.',
  user: { login: 'octocat' },
  head: { ref: 'feat/rate-limit' },
  base: { ref: 'main' },
  draft: false,
  additions: 30,
  deletions: 4,
  changed_files: 2,
}

function fileEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    filename: 'src/auth.ts',
    status: 'modified',
    additions: 20,
    deletions: 3,
    changes: 23,
    patch: '@@ -1,1 +1,2 @@\n ctx\n+new line',
    ...overrides,
  }
}

const BASE_ROUTES: Route[] = [
  { match: (p) => p === '/repos/octo/app/pulls/7', body: PR_META },
  {
    match: (p) => p === '/repos/octo/app/pulls/7/files',
    body: [
      fileEntry(),
      fileEntry({
        filename: 'src/README.md',
        additions: 10,
        deletions: 1,
        changes: 11,
      }),
    ],
  },
  {
    match: (p) => p === '/repos/octo/app/contents/.repolens.yml',
    body: {
      content: btoa('review:\n  enabled: true\n'),
      encoding: 'base64',
      size: 26,
    },
  },
  {
    match: (p) => p === '/repos/octo/app/issues/7/comments',
    body: { id: 555 },
  },
]

const GOOD_LLM_OUTPUT = [
  '### Summary',
  'Adds rate limiting to failed logins.',
  '### Risks / things to check',
  '- Counter storage may grow.',
  '### Suggestions',
  '- Consider expiry on counters.',
  '---END OF REVIEW---',
  'IGNORED AFTER MARKER',
].join('\n')

/** Mock LLM that records its prompt and returns a canned response. */
function mockProvider(
  response: string,
  shouldThrow = false,
): { provider: LLMProvider; prompts: string[] } {
  const prompts: string[] = []
  return {
    provider: {
      complete: async (input: string) => {
        prompts.push(input)
        if (shouldThrow) throw new Error('llm down')
        return response
      },
    },
    prompts,
  }
}

describe('runReviewJob', () => {
  let testEnv: Env
  beforeAll(async () => {
    testEnv = envWithPrivateKey(await generateTestPrivateKeyPem())
  })

  it('posts one review comment with LLM summary and honest footer', async () => {
    const { fetchImpl, calls } = mockGitHubFetch(BASE_ROUTES)
    const { provider, prompts } = mockProvider(GOOD_LLM_OUTPUT)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl, provider },
    )
    expect(result.status).toBe('posted')
    expect(result.commentId).toBe(555)
    expect(result.degraded).toBe(false)
    // Prompt carries delimited untrusted data and the injection fence.
    expect(prompts[0]).toContain('<diff_begin>')
    expect(prompts[0]).toContain('<diff_end>')
    expect(prompts[0]).toContain('UNTRUSTED DATA')
    const commentCall = calls.find((call) => call.url.includes('/comments'))
    if (commentCall === undefined) throw new Error('expected comment call')
    const sent = JSON.parse(commentCall.init?.body as string) as {
      body: string
    }
    expect(sent.body).toContain('### RepoLens review')
    expect(sent.body).toContain('Adds rate limiting to failed logins.')
    expect(sent.body).toContain('Gemini Flash') // LLM disclosure
  })

  it('degrades to deterministic summary when the LLM throws', async () => {
    const { fetchImpl, calls } = mockGitHubFetch(BASE_ROUTES)
    const { provider } = mockProvider('', true)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl, provider },
    )
    expect(result.status).toBe('posted')
    expect(result.degraded).toBe(true)
    const commentCall = calls.find((call) => call.url.includes('/comments'))
    const sent = JSON.parse(commentCall?.init?.body as string) as {
      body: string
    }
    expect(sent.body).toContain('deterministic summary')
    expect(sent.body).toContain(
      'No repository content was sent to any LLM provider',
    )
  })

  it('runs deterministic-only when no provider is given', async () => {
    const { fetchImpl, calls } = mockGitHubFetch(BASE_ROUTES)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl },
    )
    expect(result.status).toBe('posted')
    expect(result.degraded).toBe(false)
    const commentCall = calls.find((call) => call.url.includes('/comments'))
    const sent = JSON.parse(commentCall?.init?.body as string) as {
      body: string
    }
    expect(sent.body).toContain(
      'No repository content was sent to any LLM provider',
    )
  })

  it('skips when review is disabled via .repolens.yml', async () => {
    const routes: Route[] = [
      { match: (p) => p === '/repos/octo/app/pulls/7', body: PR_META },
      {
        match: (p) => p === '/repos/octo/app/contents/.repolens.yml',
        body: {
          content: btoa('review:\n  enabled: false\n'),
          encoding: 'base64',
          size: 26,
        },
      },
    ]
    const { fetchImpl, calls } = mockGitHubFetch(routes)
    const { provider } = mockProvider(GOOD_LLM_OUTPUT)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl, provider },
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('review-disabled')
    expect(calls.some((call) => call.url.includes('/comments'))).toBe(false)
  })

  it('skips draft PRs', async () => {
    const routes: Route[] = [
      {
        match: (p) => p === '/repos/octo/app/pulls/7',
        body: { ...PR_META, draft: true },
      },
    ]
    const { fetchImpl, calls } = mockGitHubFetch(routes)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl },
    )
    expect(result).toEqual({ status: 'skipped', reason: 'draft-pr' })
    expect(calls.some((call) => call.url.includes('/comments'))).toBe(false)
  })

  it('posts nothing when every file was filtered out', async () => {
    const routes: Route[] = [
      { match: (p) => p === '/repos/octo/app/pulls/7', body: PR_META },
      {
        match: (p) => p === '/repos/octo/app/pulls/7/files',
        body: [fileEntry({ filename: 'package-lock.json' })],
      },
      {
        match: (p) => p === '/repos/octo/app/contents/.repolens.yml',
        body: {
          content: btoa('review:\n  enabled: true\n'),
          encoding: 'base64',
          size: 26,
        },
      },
    ]
    const { fetchImpl, calls } = mockGitHubFetch(routes)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl },
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('all-files-filtered')
    expect(calls.some((call) => call.url.includes('/comments'))).toBe(false)
  })

  it('posts nothing when the diff is empty', async () => {
    const routes: Route[] = [
      { match: (p) => p === '/repos/octo/app/pulls/7', body: PR_META },
      { match: (p) => p === '/repos/octo/app/pulls/7/files', body: [] },
      {
        match: (p) => p === '/repos/octo/app/contents/.repolens.yml',
        body: {
          content: btoa('review:\n  enabled: true\n'),
          encoding: 'base64',
          size: 26,
        },
      },
    ]
    const { fetchImpl, calls } = mockGitHubFetch(routes)
    const result = await runReviewJob(
      testEnv,
      { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
      { fetchImpl },
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('empty-diff')
    expect(calls.some((call) => call.url.includes('/comments'))).toBe(false)
  })

  it('propagates GitHub API failure (retry, post nothing)', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response('nope', { status: 500 })) as typeof fetch
    await expect(
      runReviewJob(
        testEnv,
        { installationId: 3, owner: 'octo', repo: 'app', number: 7 },
        { fetchImpl },
      ),
    ).rejects.toThrow(/status 500/)
  })
})

describe('sanitizeReviewOutput', () => {
  it('strips everything after the end marker and repeated headings', () => {
    const cleaned = sanitizeReviewOutput(GOOD_LLM_OUTPUT)
    expect(cleaned).not.toContain('IGNORED AFTER MARKER')
    expect(cleaned).not.toContain('### RepoLens review')
    expect(cleaned).toContain('Adds rate limiting')
  })

  it('caps very long output', () => {
    const cleaned = sanitizeReviewOutput(`x`.repeat(20_000))
    expect(cleaned.length).toBeLessThanOrEqual(6000 + '\n…(truncated)'.length)
    expect(cleaned).toContain('truncated')
  })
})
