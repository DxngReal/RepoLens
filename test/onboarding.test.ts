import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzeManifests } from '../src/analyze/manifests'
import {
  buildOnboardingReport,
  runOnboardingJob,
} from '../src/analyze/onboarding'
import type { Env } from '../src/env'

/**
 * Phase 3 tests (spec §12): deterministic report builder and the full
 * onboarding job with a mocked GitHub fetch (hard rule: no real GitHub
 * API calls). LLM is not called anywhere in Phase 3.
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

function envWithPrivateKey(privateKeyPem: string): Env {
  return {
    ...(env as object),
    GH_APP_ID: '12345',
    GH_PRIVATE_KEY: privateKeyPem,
    GH_WEBHOOK_SECRET: 'test-webhook-secret',
  } as unknown as Env
}

/**
 * Mock GitHub API: serves the installation-token exchange, then
 * caller-supplied routes; unknown paths throw so tests fail loudly.
 */
function mockGitHubFetch(routes: Record<string, unknown>): {
  fetchImpl: typeof fetch
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlText = String(url)
    calls.push({ url: urlText, init })
    const urlPath = urlText.replace(/^https:\/\/api\.github\.com/, '')
    const path = urlPath.split('?')[0]
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
    // Exact match wins over prefix match so `/issues` is not shadowed
    // by the repo-metadata route.
    const keys = Object.keys(routes)
    const exact = keys.find((key) => path === key)
    const prefix = keys.find((key) => path.startsWith(key))
    const match = exact ?? prefix
    if (match === undefined) {
      throw new Error(`unexpected GitHub API call: ${path}`)
    }
    const value = routes[match]
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const REPO_RESPONSE = {
  name: 'sample-repo',
  full_name: 'octocat/sample-repo',
  description: 'A <script>alert(1)</script> sample',
  default_branch: 'main',
  size: 1024,
  language: 'TypeScript',
  private: false,
}

const TREE_RESPONSE = {
  tree: [
    { path: 'src', type: 'tree' },
    { path: 'docs', type: 'tree' },
    { path: 'node_modules', type: 'tree' },
    { path: 'package.json', type: 'blob' },
    { path: 'tsconfig.json', type: 'blob' },
    { path: 'LICENSE', type: 'blob' },
    { path: '.repolens.yml', type: 'blob' },
    { path: 'src/index.ts', type: 'blob' },
  ],
  truncated: false,
}

function contentsResponse(content: string): unknown {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)))
  return { content: base64, encoding: 'base64', size: content.length }
}

const PACKAGE_JSON = JSON.stringify({
  name: 'sample-repo',
  scripts: { build: 'tsc', test: 'vitest run' },
  dependencies: { hono: '^4' },
  devDependencies: { typescript: '^5' },
})

const fullRoutes: Record<string, unknown> = {
  '/repos/octocat/sample-repo': REPO_RESPONSE,
  '/repos/octocat/sample-repo/git/trees/main': TREE_RESPONSE,
  '/repos/octocat/sample-repo/contents/package.json':
    contentsResponse(PACKAGE_JSON),
  '/repos/octocat/sample-repo/contents/tsconfig.json': contentsResponse('{}'),
  '/repos/octocat/sample-repo/contents/.repolens.yml': contentsResponse(
    'review:\n  enabled: true\n',
  ),
  '/repos/octocat/sample-repo/contents/LICENSE':
    contentsResponse('MIT License'),
  '/repos/octocat/sample-repo/issues': { number: 42 },
}

describe('buildOnboardingReport', () => {
  it('renders repository facts, manifests, structure, and license', () => {
    const analysis = analyzeManifests({
      'package.json': PACKAGE_JSON,
      'tsconfig.json': '{}',
    })
    const report = buildOnboardingReport({
      metadata: {
        name: 'sample-repo',
        fullName: 'octocat/sample-repo',
        description: 'A <script>alert(1)</script> sample',
        defaultBranch: 'main',
        sizeKb: 1024,
        language: 'TypeScript',
        isPrivate: false,
      },
      tree: {
        directories: ['src', 'docs', 'node_modules'],
        files: ['package.json', 'tsconfig.json', 'LICENSE'],
      },
      manifests: analysis,
      licenseFile: 'LICENSE',
      configNote: null,
      llmSummary: null,
      llmNote:
        'note: LLM summaries are not enabled in this build — posting the deterministic report only.',
    })
    expect(report).toContain('# RepoLens onboarding report')
    expect(report).toContain('**Directories (2):** `src`, `docs`') // node_modules ignored
    expect(report).toContain('| Manifest | Language | Dependencies |')
    expect(report).toContain('`build`, `test`')
    expect(report).toContain('A license file is present: `LICENSE`.')
    expect(report).toContain('LLM summaries are not enabled')
    expect(report.endsWith('_Automated report by RepoLens')).toBe(false)
    expect(report).toContain('automated learning aid')
  })

  it('escapes markdown from untrusted repo content', () => {
    const analysis = analyzeManifests({})
    const report = buildOnboardingReport({
      metadata: {
        name: '#repo *x* [link](https://x) `code` @here <b>',
        fullName: 'o/#r',
        description: null,
        defaultBranch: 'main\\main',
        sizeKb: 0,
        language: null,
        isPrivate: true,
      },
      tree: { directories: [], files: [] },
      manifests: analysis,
      licenseFile: null,
      configNote: null,
      llmSummary: null,
      llmNote: null,
    })
    expect(report).toContain(
      'Name: \\#repo \\*x\\* \\[link\\](https://x) \\`code\\` \\@here \\<b\\>',
    )
    expect(report).not.toContain('#repo *x*')
    expect(report).toContain('_(none detected)_')
  })

  it('renders config note and empty-repo paths', () => {
    const report = buildOnboardingReport({
      metadata: {
        name: 'r',
        fullName: 'o/r',
        description: null,
        defaultBranch: 'main',
        sizeKb: 0,
        language: null,
        isPrivate: false,
      },
      tree: { directories: [], files: [] },
      manifests: analyzeManifests({}),
      licenseFile: null,
      configNote:
        'note: .repolens.yml is unparseable — using default configuration',
      llmSummary: 'Generated summary text.',
      llmNote: null,
    })
    expect(report).toContain('note: .repolens.yml is unparseable')
    expect(report).toContain('_Repository root is empty._')
    expect(report).toContain('## Plain-language summary')
    expect(report).toContain('Generated summary text.')
  })
})

describe('runOnboardingJob', () => {
  let testEnv: Env

  beforeAll(async () => {
    testEnv = envWithPrivateKey(await generateTestPrivateKeyPem())
  })

  it('posts the report issue and returns the issue number', async () => {
    const { fetchImpl, calls } = mockGitHubFetch(fullRoutes)
    const result = await runOnboardingJob(
      testEnv,
      {
        installationId: 1,
        owner: 'octocat',
        repo: 'sample-repo',
      },
      fetchImpl,
    )
    expect(result.status).toBe('posted')
    expect(result.issueNumber).toBe(42)
    const issueCall = calls.find((call) => call.url.endsWith('/issues'))
    if (issueCall === undefined) {
      throw new Error('expected an issue-creation call')
    }
    expect(issueCall.init?.method).toBe('POST')
    const body = JSON.parse(issueCall.init?.body as string) as {
      title: string
      body: string
    }
    expect(body.title).toBe('RepoLens onboarding report')
    expect(body.body).toContain('octocat/sample-repo')
    // Non-token calls carry the installation token bearer header.
    for (const call of calls) {
      const url = call.url
      if (url.includes('/access_tokens')) continue
      const headers = new Headers((call.init as RequestInit).headers)
      expect(headers.get('authorization')).toBe(
        'Bearer mock-installation-token',
      )
    }
  })

  it('skips when onboarding is disabled via .repolens.yml', async () => {
    const routes: Record<string, unknown> = {
      ...fullRoutes,
      '/repos/octocat/sample-repo/contents/.repolens.yml': contentsResponse(
        'onboarding:\n  enabled: false\n',
      ),
    }
    const { fetchImpl, calls } = mockGitHubFetch(routes)
    const result = await runOnboardingJob(
      testEnv,
      {
        installationId: 1,
        owner: 'octocat',
        repo: 'sample-repo',
      },
      fetchImpl,
    )
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('onboarding-disabled')
    expect(calls.some((call) => call.url.endsWith('/issues'))).toBe(false)
  })

  it('invalid .repolens.yml → defaults + note in the report, still posts', async () => {
    const routes: Record<string, unknown> = {
      ...fullRoutes,
      '/repos/octocat/sample-repo/contents/.repolens.yml':
        contentsResponse('::::'),
    }
    const { fetchImpl } = mockGitHubFetch(routes)
    const result = await runOnboardingJob(
      testEnv,
      {
        installationId: 1,
        owner: 'octocat',
        repo: 'sample-repo',
      },
      fetchImpl,
    )
    expect(result.status).toBe('posted')
  })

  it('propagates GitHub API failure instead of posting a half-report', async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response('rate limited', { status: 403 })
    }) as typeof fetch
    await expect(
      runOnboardingJob(
        testEnv,
        {
          installationId: 1,
          owner: 'octocat',
          repo: 'sample-repo',
        },
        fetchImpl,
      ),
    ).rejects.toThrow()
  })
})
