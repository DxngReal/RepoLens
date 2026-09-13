/**
 * Manifest detection for the onboarding report (spec §8).
 *
 * Pure analysis: input is already-fetched file contents (path → text).
 * All file content is untrusted data (spec §3): parsed defensively under
 * hard size caps, never executed, and malformed content degrades to
 * "not counted" instead of throwing (spec §13).
 *
 * Counting subset (documented, deterministic):
 * - package.json / composer.json → JSON.parse of dependency objects
 * - requirements.txt → non-empty, non-comment lines (options like `-r`
 *   and `-e` are excluded)
 * - pyproject.toml → `[project] dependencies = [...]` items plus keys in
 *   `[tool.poetry.dependencies]` (excluding `python`)
 * - go.mod → `require (...)` block entries + single-line `require x v`
 * - Cargo.toml → keys under `[dependencies]`
 * - pom.xml → `<dependency>` element count
 * - Gemfile → lines beginning with `gem `
 */

export const MANIFEST_PATHS = [
  'package.json',
  'tsconfig.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'composer.json',
  'Gemfile',
] as const

export type ManifestPath = (typeof MANIFEST_PATHS)[number]

const MANIFEST_LANGUAGE: Record<ManifestPath, string> = {
  'package.json': 'JavaScript',
  'tsconfig.json': 'TypeScript',
  'requirements.txt': 'Python',
  'pyproject.toml': 'Python',
  'go.mod': 'Go',
  'Cargo.toml': 'Rust',
  'pom.xml': 'Java',
  'composer.json': 'PHP',
  Gemfile: 'Ruby',
}

/**
 * Deterministic priority for picking the primary language when several
 * manifests are present. TypeScript wins over JavaScript only when
 * tsconfig.json exists next to package.json.
 */
const LANGUAGE_PRIORITY = [
  'TypeScript',
  'JavaScript',
  'Python',
  'Go',
  'Rust',
  'Java',
  'PHP',
  'Ruby',
] as const

/** Refuse to parse untrusted files larger than this (defense in depth). */
const MAX_PARSED_BYTES = 256 * 1024

export type DetectedManifest = {
  path: ManifestPath
  language: string
  dependencyCount: number | null
}

export type ManifestAnalysis = {
  detected: DetectedManifest[]
  languages: string[]
  primaryLanguage: string | null
  npmScripts: string[]
  totalDependencies: number
  dependencyBreakdown: Record<string, number>
}

function isOversized(content: string): boolean {
  return content.length > MAX_PARSED_BYTES
}

function safeJsonParse(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function countKeys(value: unknown): number {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 0
  }
  return Object.keys(value as Record<string, unknown>).length
}

function countRequirementsTxt(content: string): number {
  let count = 0
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith('-')) {
      continue
    }
    count += 1
  }
  return count
}

/** Counts items in a single- or multi-line TOML array starting at `= [`. */
function countTomlArray(lines: string[], startIndex: number): number {
  let joined = ''
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    joined += ` ${line}`
    if (line.includes(']')) {
      break
    }
  }
  const inner = joined.slice(joined.indexOf('[') + 1, joined.lastIndexOf(']'))
  const items = inner
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items.length
}

function countPyprojectToml(content: string): number {
  const lines = content.split('\n')
  let count = 0
  let section = ''
  let collectingArray = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line
      collectingArray = false
      continue
    }
    if (collectingArray) {
      if (line.includes(']')) collectingArray = false
      continue // items were counted below on the opening line
    }

    if (section === '[project]' || section.startsWith('[project.')) {
      const match = /^dependencies\s*=\s*\[/.exec(line)
      if (match) {
        count += countTomlArray(lines, i)
        if (!line.includes(']')) collectingArray = true
      }
      continue
    }

    if (section === '[tool.poetry.dependencies]') {
      const match = /^[A-Za-z0-9_.-]+\s*=/.exec(line)
      if (match && !/^python\s*=/.test(line)) {
        count += 1
      }
    }
  }
  return count
}

function countGoMod(content: string): number {
  let count = 0
  let inRequireBlock = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('//') || line.length === 0) continue
    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false
        continue
      }
      count += 1
      continue
    }
    if (/^require\s*\(/.test(line)) {
      inRequireBlock = true
      continue
    }
    if (/^require\s+\S+\s+v\S+/.test(line)) {
      count += 1
    }
  }
  return count
}

function countCargoToml(content: string): number {
  let count = 0
  let section = ''
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line
      continue
    }
    if (section === '[dependencies]' && /^[A-Za-z0-9_-]+\s*=/.test(line)) {
      count += 1
    }
  }
  return count
}

function countPomXml(content: string): number {
  return content.split('<dependency>').length - 1
}

function countGemfile(content: string): number {
  let count = 0
  for (const rawLine of content.split('\n')) {
    if (/^gem\s+['"]/.test(rawLine.trim())) count += 1
  }
  return count
}

/** Per-manifest dependency counting; `null` = manifest has no deps. */
function countDependencies(path: ManifestPath, content: string): number | null {
  if (isOversized(content)) return null
  switch (path) {
    case 'package.json': {
      const parsed = safeJsonParse(content)
      if (!parsed) return 0
      return countKeys(parsed.dependencies) + countKeys(parsed.devDependencies)
    }
    case 'composer.json': {
      const parsed = safeJsonParse(content)
      if (!parsed) return 0
      return countKeys(parsed.require) + countKeys(parsed['require-dev'])
    }
    case 'tsconfig.json':
      return null
    case 'requirements.txt':
      return countRequirementsTxt(content)
    case 'pyproject.toml':
      return countPyprojectToml(content)
    case 'go.mod':
      return countGoMod(content)
    case 'Cargo.toml':
      return countCargoToml(content)
    case 'pom.xml':
      return countPomXml(content)
    case 'Gemfile':
      return countGemfile(content)
  }
}

/** npm script names from package.json; empty on malformed/oversized input. */
export function extractNpmScripts(content: string | undefined): string[] {
  if (!content || isOversized(content)) return []
  const parsed = safeJsonParse(content)
  if (!parsed) return []
  const scripts = parsed.scripts
  if (
    scripts === null ||
    typeof scripts !== 'object' ||
    Array.isArray(scripts)
  ) {
    return []
  }
  return Object.keys(scripts as Record<string, unknown>)
}

/**
 * Detects manifests among the provided files and derives language and
 * dependency information. Keys of `files` are root-relative paths.
 */
export function analyzeManifests(
  files: Readonly<Record<string, string>>,
): ManifestAnalysis {
  const detected: DetectedManifest[] = []
  const dependencyBreakdown: Record<string, number> = {}

  for (const path of MANIFEST_PATHS) {
    const content = files[path]
    if (typeof content !== 'string' || isOversized(content)) continue
    const dependencyCount = countDependencies(path, content)
    detected.push({ path, language: MANIFEST_LANGUAGE[path], dependencyCount })
    if (dependencyCount !== null && dependencyCount > 0) {
      dependencyBreakdown[path] = dependencyCount
    }
  }

  const languages = [
    ...new Set(detected.map((manifest) => manifest.language)),
  ].sort(
    (a, b) =>
      LANGUAGE_PRIORITY.indexOf(a as (typeof LANGUAGE_PRIORITY)[number]) -
      LANGUAGE_PRIORITY.indexOf(b as (typeof LANGUAGE_PRIORITY)[number]),
  )

  return {
    detected,
    languages,
    primaryLanguage: languages[0] ?? null,
    npmScripts: extractNpmScripts(files['package.json']),
    totalDependencies: Object.values(dependencyBreakdown).reduce(
      (sum, count) => sum + count,
      0,
    ),
    dependencyBreakdown,
  }
}

const LICENSE_FILE_PREFIXES = ['LICENSE', 'LICENCE', 'COPYING', 'NOTICE']

/**
 * Returns the first root-level license-looking filename, or null.
 * Presence only — RepoLens does not interpret license text (untrusted).
 */
export function detectLicenseFile(
  rootFilePaths: readonly string[],
): string | null {
  for (const path of rootFilePaths) {
    const upper = path.toUpperCase()
    if (LICENSE_FILE_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      return path
    }
  }
  return null
}
