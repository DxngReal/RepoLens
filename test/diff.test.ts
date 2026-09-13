import { describe, expect, it } from 'vitest'
import {
  buildDiffContext,
  globToRegExp,
  isGenerated,
  isLockfile,
  selectFilesForReview,
} from '../src/analyze/diff'
import type { PrFile } from '../src/github/pulls'

/**
 * Phase 4 tests (spec §12): diff filtering, budgets, and skipped-file
 * notes. Pure analysis — no network, no LLM.
 */

function prFile(overrides: Partial<PrFile> = {}): PrFile {
  return {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 10,
    deletions: 2,
    changes: 12,
    patch: '@@ -1,2 +1,3 @@\n context\n+added',
    ...overrides,
  }
}

describe('lockfile/generated heuristics', () => {
  it('identifies common lockfiles', () => {
    expect(isLockfile('package-lock.json')).toBe(true)
    expect(isLockfile('sub/yarn.lock')).toBe(true)
    expect(isLockfile('pnpm-lock.yaml')).toBe(true)
    expect(isLockfile('src/go.sum')).toBe(true)
    expect(isLockfile('Gemfile.lock')).toBe(true)
    expect(isLockfile('src/index.ts')).toBe(false)
  })

  it('identifies generated paths', () => {
    expect(isGenerated('dist/bundle.js')).toBe(true)
    expect(isGenerated('packages/app/build/out.js')).toBe(true)
    expect(isGenerated('app/vendor/lib.go')).toBe(true)
    expect(isGenerated('styles.min.css')).toBe(true)
    expect(isGenerated('types.d.ts')).toBe(true)
    expect(isGenerated('src/app.ts')).toBe(false)
  })
})

describe('globToRegExp', () => {
  it('supports **, *, and ? with plain literals', () => {
    expect(globToRegExp('**/*.lock').test('a/b/c.lock')).toBe(true)
    expect(globToRegExp('**/*.lock').test('a/b/c.json')).toBe(false)
    expect(globToRegExp('dist/**').test('dist/x.js')).toBe(true)
    expect(globToRegExp('dist/**').test('src/x.js')).toBe(false)
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true)
    expect(globToRegExp('docs/*.md').test('docs/a/b.md')).toBe(false)
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true)
    expect(globToRegExp('file?.txt').test('file12.txt')).toBe(false)
  })
})

describe('selectFilesForReview', () => {
  const budgets = { maxDiffLines: 1500, maxFileLines: 500 }

  it('includes normal files and counts used lines', () => {
    const selection = selectFilesForReview(
      [prFile(), prFile({ filename: 'src/b.ts', changes: 8 })],
      budgets,
    )
    expect(selection.included).toHaveLength(2)
    expect(selection.usedLines).toBe(20)
    expect(selection.skipped).toEqual([])
  })

  it('skips lockfiles, generated paths, and no-patch files', () => {
    const selection = selectFilesForReview(
      [
        prFile({ filename: 'package-lock.json' }),
        prFile({ filename: 'dist/out.js' }),
        prFile({ patch: null, changes: 0 }), // binary-ish
        prFile({ filename: 'src/keep.ts' }),
      ],
      budgets,
    )
    expect(selection.included.map((f) => f.filename)).toEqual(['src/keep.ts'])
    expect(selection.skipped.map((s) => s.reason)).toEqual([
      'lockfile',
      'generated',
      'no-patch',
    ])
  })

  it('skips files over maxFileLines', () => {
    const selection = selectFilesForReview(
      [prFile({ filename: 'big.ts', changes: 501 })],
      { maxDiffLines: 1500, maxFileLines: 500 },
    )
    expect(selection.included).toHaveLength(0)
    expect(selection.skipped[0]?.reason).toBe('file-too-large')
  })

  it('packs greedily up to the budget and notes the rest as skipped', () => {
    const files = [
      prFile({ filename: 'a.ts', changes: 900 }),
      prFile({ filename: 'b.ts', changes: 900 }),
      prFile({ filename: 'c.ts', changes: 10 }),
    ]
    const selection = selectFilesForReview(files, {
      maxDiffLines: 1500,
      maxFileLines: 1000,
    })
    // a.ts fits; b.ts does not; c.ts still fits in the remaining 600.
    expect(selection.included.map((f) => f.filename)).toEqual(['a.ts', 'c.ts'])
    expect(selection.usedLines).toBe(910)
    expect(selection.skipped.map((s) => s.filename)).toEqual(['b.ts'])
    expect(selection.skipped[0]?.reason).toBe('budget-exhausted')
  })

  it('honors exclude globs from .repolens.yml', () => {
    const selection = selectFilesForReview(
      [
        prFile({ filename: 'docs/generated.md' }),
        prFile({ filename: 'src/x.ts' }),
      ],
      budgets,
      ['docs/**'],
    )
    expect(selection.included.map((f) => f.filename)).toEqual(['src/x.ts'])
    expect(selection.skipped[0]).toEqual({
      filename: 'docs/generated.md',
      reason: 'excluded-by-config',
    })
  })
})

describe('buildDiffContext', () => {
  it('wraps included files in delimited blocks', () => {
    const selection = selectFilesForReview([prFile()], {
      maxDiffLines: 100,
      maxFileLines: 50,
    })
    const context = buildDiffContext(selection)
    expect(context).toContain('--- FILE: src/a.ts')
    expect(context).toContain('```diff')
    expect(context).toContain('+added')
  })
})
