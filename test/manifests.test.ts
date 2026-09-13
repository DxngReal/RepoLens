import { describe, expect, it } from 'vitest'
import {
  analyzeManifests,
  detectLicenseFile,
  extractNpmScripts,
} from '../src/analyze/manifests'

/**
 * Phase 3 tests (spec §12): manifest detection with fixtures for
 * Node/TS/Go/Python/Rust/Java ecosystems. Pure analysis — no network.
 */

const PACKAGE_JSON = JSON.stringify({
  name: 'sample',
  scripts: { build: 'tsc', test: 'vitest run', deploy: 'wrangler deploy' },
  dependencies: { hono: '^4', zod: '^3' },
  devDependencies: { typescript: '^5', vitest: '^3', biome: '^2' },
})

describe('analyzeManifests', () => {
  it('returns empty analysis for an empty repo', () => {
    const analysis = analyzeManifests({})
    expect(analysis.detected).toHaveLength(0)
    expect(analysis.primaryLanguage).toBeNull()
    expect(analysis.npmScripts).toEqual([])
    expect(analysis.totalDependencies).toBe(0)
  })

  it('detects Node + TypeScript with dependency counts and scripts', () => {
    const analysis = analyzeManifests({
      'package.json': PACKAGE_JSON,
      'tsconfig.json': '{}',
    })
    expect(analysis.primaryLanguage).toBe('TypeScript')
    expect(analysis.languages).toEqual(['TypeScript', 'JavaScript'])
    expect(analysis.npmScripts).toEqual(['build', 'test', 'deploy'])
    const pkg = analysis.detected.find((m) => m.path === 'package.json')
    expect(pkg?.dependencyCount).toBe(5) // 2 deps + 3 devDeps
  })

  it('counts package.json with dependencies only', () => {
    const analysis = analyzeManifests({
      'package.json': JSON.stringify({ dependencies: { a: '1' } }),
    })
    expect(analysis.primaryLanguage).toBe('JavaScript')
    const pkg = analysis.detected.find((m) => m.path === 'package.json')
    expect(pkg?.dependencyCount).toBe(1)
  })

  it('detects Go repos via go.mod (block + single-line requires)', () => {
    const goMod = [
      'module example.com/app',
      '',
      'go 1.22',
      '',
      'require (',
      '\tgithub.com/foo/bar v1.2.3',
      '\tgolang.org/x/mod v0.1.0',
      ')',
      '',
      'require github.com/one/more v0.0.1',
    ].join('\n')
    const analysis = analyzeManifests({ 'go.mod': goMod })
    expect(analysis.primaryLanguage).toBe('Go')
    const go = analysis.detected.find((m) => m.path === 'go.mod')
    expect(go?.dependencyCount).toBe(3)
  })

  it('detects Python via requirements.txt (skips comments and options)', () => {
    const requirements = [
      '# runtime deps',
      'fastapi>=0.110',
      'uvicorn[standard]==0.29',
      '',
      '-r other.txt',
      '-e .',
      '  spaced-package~=1.0 ',
    ].join('\n')
    const analysis = analyzeManifests({ 'requirements.txt': requirements })
    expect(analysis.primaryLanguage).toBe('Python')
    const req = analysis.detected.find((m) => m.path === 'requirements.txt')
    expect(req?.dependencyCount).toBe(3)
  })

  it('detects Python via pyproject.toml (PEP 621 + poetry)', () => {
    const pyproject = [
      '[project]',
      'name = "app"',
      'dependencies = [',
      '  "fastapi>=0.110",',
      '  "uvicorn",',
      ']',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      'requests = "^2.31"',
    ].join('\n')
    const analysis = analyzeManifests({ 'pyproject.toml': pyproject })
    const py = analysis.detected.find((m) => m.path === 'pyproject.toml')
    expect(py?.dependencyCount).toBe(3) // 2 PEP-621 + poetry minus python
  })

  it('detects Rust via Cargo.toml [dependencies]', () => {
    const cargo = [
      '[package]',
      'name = "app"',
      '',
      '[dependencies]',
      'serde = "1"',
      'tokio = { version = "1", features = ["full"] }',
      '',
      '[dev-dependencies]',
      'criterion = "0.5"',
    ].join('\n')
    const analysis = analyzeManifests({ 'Cargo.toml': cargo })
    expect(analysis.primaryLanguage).toBe('Rust')
    const cargoEntry = analysis.detected.find((m) => m.path === 'Cargo.toml')
    expect(cargoEntry?.dependencyCount).toBe(2)
  })

  it('detects Java via pom.xml <dependency> count', () => {
    const pom = [
      '<project>',
      '  <dependencies>',
      '    <dependency><groupId>a</groupId></dependency>',
      '    <dependency><groupId>b</groupId></dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n')
    const analysis = analyzeManifests({ 'pom.xml': pom })
    expect(analysis.primaryLanguage).toBe('Java')
    const java = analysis.detected.find((m) => m.path === 'pom.xml')
    expect(java?.dependencyCount).toBe(2)
  })

  it('counts composer.json and Gemfile', () => {
    const composer = JSON.stringify({
      require: { php: '>=8.1', monolog: '^3' },
      'require-dev': { phpunit: '^11' },
    })
    const analysis = analyzeManifests({
      'composer.json': composer,
      Gemfile:
        "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n# gem commented",
    })
    expect(analysis.primaryLanguage).toBe('PHP') // PHP sorts before Ruby
    const php = analysis.detected.find((m) => m.path === 'composer.json')
    const ruby = analysis.detected.find((m) => m.path === 'Gemfile')
    expect(php?.dependencyCount).toBe(3) // includes php itself, like composer
    expect(ruby?.dependencyCount).toBe(2)
  })

  it('degrades malformed manifest content to zero counts, not throws', () => {
    const analysis = analyzeManifests({
      'package.json': '{ not json !!!',
      'requirements.txt': 'valid-package==1.0',
    })
    const pkg = analysis.detected.find((m) => m.path === 'package.json')
    expect(pkg?.dependencyCount).toBe(0)
    expect(analysis.totalDependencies).toBe(1)
  })

  it('ignores oversized untrusted manifest files', () => {
    const analysis = analyzeManifests({
      'package.json': `{"name":"${'x'.repeat(300 * 1024)}"}`,
    })
    expect(analysis.detected).toHaveLength(0) // skipped entirely, not parsed
    expect(analysis.npmScripts).toEqual([])
  })
})

describe('extractNpmScripts', () => {
  it('extracts script names', () => {
    expect(extractNpmScripts(PACKAGE_JSON)).toEqual(['build', 'test', 'deploy'])
  })

  it('returns empty for malformed content', () => {
    expect(extractNpmScripts('[{')).toEqual([])
    expect(extractNpmScripts(undefined)).toEqual([])
  })
})

describe('detectLicenseFile', () => {
  it('finds common license filenames case-insensitively', () => {
    expect(detectLicenseFile(['README.md', 'LICENSE'])).toBe('LICENSE')
    expect(detectLicenseFile(['license.mit'])).toBe('license.mit')
    expect(detectLicenseFile(['Licence.txt'])).toBe('Licence.txt')
    expect(detectLicenseFile(['COPYING'])).toBe('COPYING')
  })

  it('returns null when no license file exists', () => {
    expect(detectLicenseFile(['README.md', 'src/index.ts'])).toBeNull()
  })
})
