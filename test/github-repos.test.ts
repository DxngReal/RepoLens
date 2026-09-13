import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { createOnboardingIssue } from '../src/github/issues'
import {
  fetchFileContents,
  fetchRepoMetadata,
  fetchRootTree,
} from '../src/github/repos'

/**
 * Phase 3 tests (spec §12): GitHub repo/issue helpers against a mocked
 * fetch (hard rule: no real GitHub API calls). The fetch mock answers
 * the installation-token exchange first, then per-route responses.
 */

let cachedPrivateKeyPem: string | null = null

/** Generates a fresh 2048-bit RSA keypair and exports PKCS#8 PEM. */
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

type Route = {
  match: (path: string) => boolean
  status?: number
  body?: unknown
}

/**
 * Mock GitHub API: serves POST /app/installations/:id/access_tokens
 * (token exchange) plus caller-supplied routes. Asserts every request
 * carries an Authorization header once the token exists.
 */
function mockGitHubFetch(routes: Route[]): {
  fetchImpl: typeof fetch
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
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

describe('github repos/issues helpers', () => {
  let testEnv: Env

  beforeAll(async () => {
    cachedPrivateKeyPem = await generateTestPrivateKeyPem()
    testEnv = envWithPrivateKey(cachedPrivateKeyPem)
  })

  describe('fetchRepoMetadata', () => {
    it('normalizes repo fields and encodes owner/repo', async () => {
      const { fetchImpl, calls } = mockGitHubFetch([
        {
          match: (p) => p === '/repos/o/r',
          body: {
            name: 'r',
            full_name: 'o/r',
            description: 'd',
            default_branch: 'main',
            size: 5,
            language: 'Go',
            private: true,
          },
        },
      ])
      const meta = await fetchRepoMetadata(testEnv, 7, 'o', 'r', fetchImpl)
      expect(meta).toEqual({
        name: 'r',
        fullName: 'o/r',
        description: 'd',
        defaultBranch: 'main',
        sizeKb: 5,
        language: 'Go',
        isPrivate: true,
      })
      expect(calls[0]?.url).toBe(
        'https://api.github.com/app/installations/7/access_tokens',
      )
      expect(calls[1]?.url).toBe('https://api.github.com/repos/o/r')
      const headers = new Headers(calls[1]?.init?.headers)
      expect(headers.get('authorization')).toBe(
        'Bearer mock-installation-token',
      )
    })

    it('throws a status-only GitHubApiError on HTTP failure', async () => {
      const { fetchImpl } = mockGitHubFetch([
        { match: (p) => p === '/repos/o/missing', status: 404 },
      ])
      await expect(
        fetchRepoMetadata(testEnv, 7, 'o', 'missing', fetchImpl),
      ).rejects.toThrow(/status 404/)
    })

    it('tolerates missing optional fields', async () => {
      const { fetchImpl } = mockGitHubFetch([
        {
          match: (p) => p === '/repos/o/r',
          body: { name: 'r', full_name: 'o/r', default_branch: 'main' },
        },
      ])
      const meta = await fetchRepoMetadata(testEnv, 7, 'o', 'r', fetchImpl)
      expect(meta.description).toBeNull()
      expect(meta.language).toBeNull()
      expect(meta.sizeKb).toBe(0)
      expect(meta.isPrivate).toBe(false)
    })
  })

  describe('fetchRootTree', () => {
    it('splits root-level dirs and files, sorted, ignoring nested paths', async () => {
      const { fetchImpl, calls } = mockGitHubFetch([
        {
          match: (p) => p === '/repos/o/r/git/trees/main',
          body: {
            tree: [
              { path: 'z-dir', type: 'tree' },
              { path: 'a-dir', type: 'tree' },
              { path: 'README.md', type: 'blob' },
              { path: 'src/index.ts', type: 'blob' },
              { path: 'src', type: 'tree' },
            ],
            truncated: false,
          },
        },
      ])
      const tree = await fetchRootTree(testEnv, 7, 'o', 'r', 'main', fetchImpl)
      expect(tree.directories).toEqual(['a-dir', 'src', 'z-dir'])
      expect(tree.files).toEqual(['README.md'])
      expect(calls[calls.length - 1]?.url).toContain('/git/trees/main')
    })

    it('throws on a truncated tree instead of analyzing partial data', async () => {
      const { fetchImpl } = mockGitHubFetch([
        {
          match: (p) => p === '/repos/o/r/git/trees/main',
          body: { tree: [], truncated: true },
        },
      ])
      await expect(
        fetchRootTree(testEnv, 7, 'o', 'r', 'main', fetchImpl),
      ).rejects.toThrow(/truncated/)
    })

    it('empty tree (never-pushed repo) yields empty lists', async () => {
      const { fetchImpl } = mockGitHubFetch([
        { match: (p) => p === '/repos/o/r/git/trees/main', body: { tree: [] } },
      ])
      const tree = await fetchRootTree(testEnv, 7, 'o', 'r', 'main', fetchImpl)
      expect(tree.directories).toEqual([])
      expect(tree.files).toEqual([])
    })
  })

  describe('fetchFileContents', () => {
    it('decodes base64 contents into a path → text map', async () => {
      const content = btoa('hello: world')
      const { fetchImpl } = mockGitHubFetch([
        {
          match: (p) => p === '/repos/o/r/contents/config.yml',
          body: { content, encoding: 'base64', size: 12 },
        },
      ])
      const result = await fetchFileContents(
        testEnv,
        7,
        'o',
        'r',
        'main',
        ['config.yml'],
        fetchImpl,
      )
      expect(result.files['config.yml']).toBe('hello: world')
      expect(result.oversizedPaths).toEqual([])
    })

    it('skips 404 files without failing the batch', async () => {
      const { fetchImpl } = mockGitHubFetch([
        { match: (p) => p.endsWith('/gone.txt'), status: 404 },
        {
          match: (p) => p.endsWith('/here.txt'),
          body: { content: btoa('x'), encoding: 'base64', size: 1 },
        },
      ])
      const result = await fetchFileContents(
        testEnv,
        7,
        'o',
        'r',
        'main',
        ['gone.txt', 'here.txt'],
        fetchImpl,
      )
      expect(result.files['here.txt']).toBe('x')
      expect('gone.txt' in result.files).toBe(false)
    })

    it('skips oversized blobs and reports them', async () => {
      const { fetchImpl } = mockGitHubFetch([
        {
          match: (p) => p.endsWith('/big.bin'),
          body: {
            content: btoa('a'.repeat(10)),
            encoding: 'base64',
            size: 300 * 1024, // above the 256KB analysis cap
          },
        },
      ])
      const result = await fetchFileContents(
        testEnv,
        7,
        'o',
        'r',
        'main',
        ['big.bin'],
        fetchImpl,
      )
      expect(result.files['big.bin']).toBeUndefined()
      expect(result.oversizedPaths).toEqual(['big.bin'])
    })
  })

  describe('createOnboardingIssue', () => {
    it('POSTs the exact title and body, returns the issue number', async () => {
      const { fetchImpl, calls } = mockGitHubFetch([
        { match: (p) => p === '/repos/o/r/issues', body: { number: 99 } },
      ])
      const number = await createOnboardingIssue(
        testEnv,
        7,
        'o',
        'r',
        'REPORT BODY',
        fetchImpl,
      )
      expect(number).toBe(99)
      const last = calls[calls.length - 1]
      expect(last?.init?.method).toBe('POST')
      const sentBody = JSON.parse(last?.init?.body as string) as {
        title: string
        body: string
      }
      expect(sentBody.title).toBe('RepoLens onboarding report')
      expect(sentBody.body).toBe('REPORT BODY')
      const headers = new Headers(last?.init?.headers)
      expect(headers.get('content-type')).toBe('application/json')
    })

    it('throws a status-only error on failure', async () => {
      const { fetchImpl } = mockGitHubFetch([
        { match: (p) => p === '/repos/o/r/issues', status: 403 },
      ])
      await expect(
        createOnboardingIssue(testEnv, 7, 'o', 'r', 'b', fetchImpl),
      ).rejects.toThrow(/status 403/)
    })
  })
})
