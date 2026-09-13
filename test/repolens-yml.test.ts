import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPOLENS_CONFIG,
  loadRepolensConfig,
  parseRepolensYml,
} from '../src/config/repolens-yml'

/**
 * Phase 3 tests (spec §10, §12): config defaults, overrides, and
 * invalid-file fallback. The parser must never throw.
 */

const VALID_YML = [
  'version: 1',
  'onboarding:',
  '  enabled: true',
  '  summary: llm',
  'review:',
  '  enabled: true',
  '  max_diff_lines: 1500',
  '  max_file_lines: 500',
  'exclude:',
  '  - "**/*.lock"',
  '  - "dist/**"',
].join('\n')

describe('parseRepolensYml', () => {
  it('parses a fully valid file', () => {
    const result = parseRepolensYml(VALID_YML)
    expect(result.status).toBe('ok')
    expect(result.note).toBeNull()
    expect(result.config).toEqual({
      version: 1,
      onboarding: { enabled: true, summary: 'llm' },
      review: { enabled: true, maxDiffLines: 1500, maxFileLines: 500 },
      exclude: ['**/*.lock', 'dist/**'],
    })
  })

  it('fills unset fields with defaults', () => {
    const result = parseRepolensYml('review:\n  enabled: false\n')
    expect(result.status).toBe('ok')
    expect(result.config.onboarding).toEqual(DEFAULT_REPOLENS_CONFIG.onboarding)
    expect(result.config.review.enabled).toBe(false)
    expect(result.config.review.maxDiffLines).toBe(1500)
    expect(result.config.exclude).toEqual([])
  })

  it('parses comments, quotes, and inline values', () => {
    const yml = [
      '# RepoLens config',
      'version: 1   # schema version',
      'onboarding:',
      "  summary: 'deterministic'",
      'exclude:',
      '  - "docs/**"   # generated docs',
    ].join('\n')
    const result = parseRepolensYml(yml)
    expect(result.status).toBe('ok')
    expect(result.config.onboarding.summary).toBe('deterministic')
    expect(result.config.exclude).toEqual(['docs/**'])
  })

  it('falls back to defaults on unparseable YAML', () => {
    const result = parseRepolensYml('onboarding: [unclosed')
    expect(result.status).toBe('invalid')
    expect(result.note).toContain('unparseable')
    expect(result.config).toEqual(DEFAULT_REPOLENS_CONFIG)
  })

  it('rejects unsupported version', () => {
    const result = parseRepolensYml('version: 2\n')
    expect(result.status).toBe('invalid')
    expect(result.config).toEqual(DEFAULT_REPOLENS_CONFIG)
  })

  it('rejects wrong scalar types field-by-field', () => {
    const cases = [
      'onboarding:\n  enabled: yes-please\n',
      'onboarding:\n  summary: gpt-5\n',
      'review:\n  max_diff_lines: lots\n',
      'review:\n  max_diff_lines: -5\n',
      'review:\n  max_file_lines: 99999999\n',
      'exclude: not-a-list\n',
      'exclude:\n  - ""\n',
      'exclude:\n  - 42\n',
    ]
    for (const yml of cases) {
      const result = parseRepolensYml(yml)
      expect(result.status).toBe('invalid')
      expect(result.config).toEqual(DEFAULT_REPOLENS_CONFIG)
      expect(result.note).not.toBeNull()
    }
  })

  it('never throws on adversarial input', () => {
    const adversarial = [
      '\tversion: 1',
      'a: *anchor',
      'b: |',
      'c: &ref',
      'key: "unbalanced',
      '- weird',
      ':\n:',
      '::: :::',
    ].join('\n')
    expect(() => parseRepolensYml(adversarial)).not.toThrow()
  })
})

describe('loadRepolensConfig', () => {
  it('missing file → defaults on, no note', () => {
    const result = loadRepolensConfig(undefined)
    expect(result.status).toBe('missing')
    expect(result.note).toBeNull()
    expect(result.config).toEqual(DEFAULT_REPOLENS_CONFIG)
  })

  it('present and valid → parsed values', () => {
    const result = loadRepolensConfig('review:\n  max_diff_lines: 800\n')
    expect(result.status).toBe('ok')
    expect(result.config.review.maxDiffLines).toBe(800)
  })

  it('present but invalid → defaults with note', () => {
    const result = loadRepolensConfig('::::')
    expect(result.status).toBe('invalid')
    expect(result.note).not.toBeNull()
    expect(result.config).toEqual(DEFAULT_REPOLENS_CONFIG)
  })

  it('oversized file → defaults with note, never parsed', () => {
    const result = loadRepolensConfig('x'.repeat(65 * 1024))
    expect(result.status).toBe('invalid')
    expect(result.note).toContain('too large')
  })
})
