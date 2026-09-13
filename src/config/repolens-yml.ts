/**
 * `.repolens.yml` parsing, validation, and defaults (spec §10).
 *
 * Hand-rolled YAML subset parser (fixed decision: no YAML dependency).
 * Supported subset: top-level scalars/maps/lists, one nesting level,
 * `- ` block sequences, quoted/plain scalars, booleans, integers,
 * inline `#` comments. Anything outside the subset is a parse error.
 *
 * Error policy (spec §10, §13): any parse or validation error → the full
 * default config plus a one-line note that the report includes. The
 * parser never throws, and bad config never crashes the job.
 * Missing file = all defaults on, without a note.
 */

export type OnboardingSummaryMode = 'llm' | 'deterministic'

export type RepolensConfig = {
  version: 1
  onboarding: {
    enabled: boolean
    summary: OnboardingSummaryMode
  }
  review: {
    enabled: boolean
    maxDiffLines: number
    maxFileLines: number
  }
  exclude: string[]
}

export type ConfigParseStatus = 'ok' | 'missing' | 'invalid'

export type ConfigParseResult = {
  config: RepolensConfig
  status: ConfigParseStatus
  /** One-line human note when status is not ok (spec §13); null otherwise. */
  note: string | null
}

export const DEFAULT_REPOLENS_CONFIG: RepolensConfig = {
  version: 1,
  onboarding: { enabled: true, summary: 'llm' },
  review: { enabled: true, maxDiffLines: 1500, maxFileLines: 500 },
  exclude: ['**/*.lock', 'dist/**'],
}

/** Refuse to parse untrusted config larger than this (defense in depth). */
const MAX_PARSED_BYTES_CONFIG = 64 * 1024

/** Upper bounds so a config file cannot inflate budgets (spec §14). */
const MAX_DIFF_LINES_CAP = 50_000
const MAX_FILE_LINES_CAP = 10_000
const MAX_EXCLUDE_PATTERNS = 100

/* ---------- tiny YAML subset parser ---------- */

type YamlScalar = string | number | boolean
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue }

class YamlSubsetError extends Error {}

/** Strips a trailing comment (`#` outside quotes, preceded by whitespace). */
function stripComment(line: string): string {
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote !== null) {
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i)
    }
  }
  return line
}

function parseScalar(raw: string): YamlScalar {
  const value = raw.trim()
  if (value.length === 0) {
    throw new YamlSubsetError('empty scalar')
  }
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    const inner = value.slice(1, -1)
    if (inner.includes(value[0])) {
      throw new YamlSubsetError('quotes inside quoted scalar')
    }
    return inner
  }
  if (value.includes('"') || value.includes("'")) {
    throw new YamlSubsetError('unbalanced quotes')
  }
  if (/[{}[\]]/.test(value)) {
    throw new YamlSubsetError('flow collections are not supported')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  return value
}

type Line = { indent: number; text: string }

function toLines(input: string): Line[] {
  if (input.charCodeAt(0) === 0xfeff) {
    input = input.slice(1) // strip BOM
  }
  const lines: Line[] = []
  for (const rawLine of input.split('\n')) {
    const withoutComment = stripComment(rawLine)
    if (withoutComment.trim().length === 0) continue
    const indentMatch = /^[ ]*/.exec(withoutComment)
    const indent = indentMatch ? indentMatch[0].length : 0
    const text = withoutComment.slice(indent).trimEnd()
    if (text.startsWith('\t')) {
      throw new YamlSubsetError('tab indentation is not supported')
    }
    lines.push({ indent, text })
  }
  return lines
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
): {
  value: YamlValue
  next: number
} {
  if (start >= lines.length) {
    throw new YamlSubsetError('unexpected end of input')
  }
  if (lines[start].text.startsWith('- ')) {
    const items: YamlValue[] = []
    let i = start
    while (i < lines.length && lines[i].indent === indent) {
      const text = lines[i].text
      if (!text.startsWith('- ')) break
      items.push(parseScalar(text.slice(2)))
      i += 1
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new YamlSubsetError('nested list items are not supported')
    }
    return { value: items, next: i }
  }

  const mapping: { [key: string]: YamlValue } = {}
  let i = start
  while (i < lines.length && lines[i].indent === indent) {
    const text = lines[i].text
    if (text.startsWith('- ')) break
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(text)
    if (!keyMatch) {
      throw new YamlSubsetError('unsupported mapping line')
    }
    const key = keyMatch[1]
    const rest = keyMatch[2].trim()
    if (rest.length > 0) {
      if (
        rest === '|' ||
        rest === '>' ||
        rest.startsWith('*') ||
        rest.startsWith('&')
      ) {
        throw new YamlSubsetError('block scalars and anchors are not supported')
      }
      mapping[key] = parseScalar(rest)
      i += 1
      continue
    }
    // Nested block must be indented deeper than the key.
    if (i + 1 >= lines.length || lines[i + 1].indent <= indent) {
      throw new YamlSubsetError(`key '${key}' has no value block`)
    }
    const nested = parseBlock(lines, i + 1, lines[i + 1].indent)
    mapping[key] = nested.value
    i = nested.next
  }
  return { value: mapping, next: i }
}

/** Parses the supported YAML subset; throws `YamlSubsetError` on anything else. */
function parseYamlSubset(input: string): YamlValue {
  const lines = toLines(input)
  if (lines.length === 0) {
    throw new YamlSubsetError('empty document')
  }
  const rootIndent = lines[0].indent
  const parsed = parseBlock(lines, 0, rootIndent)
  if (parsed.next < lines.length) {
    throw new YamlSubsetError('inconsistent indentation')
  }
  return parsed.value
}

/* ---------- validation ---------- */

function asRecord(value: YamlValue): { [key: string]: YamlValue } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as { [key: string]: YamlValue }
}

function asBoolean(value: YamlValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asBoundedInt(check: YamlValue, cap: number): number | null {
  if (typeof check !== 'number' || !Number.isInteger(check)) return null
  if (check < 1 || check > cap) return null
  return check
}

function asSummaryMode(
  value: YamlValue | undefined,
): OnboardingSummaryMode | null {
  return value === 'llm' || value === 'deterministic' ? value : null
}

function asExcludeList(check: YamlValue): string[] | null {
  if (!Array.isArray(check)) return null
  if (check.length > MAX_EXCLUDE_PATTERNS) return null
  const patterns: string[] = []
  for (const item of check) {
    if (typeof item !== 'string' || item.trim().length === 0) return null
    patterns.push(item)
  }
  return patterns
}

type FieldOutcome<T> = { ok: true; value: T } | { ok: false; note: string }

/**
 * Validates one optional scalar field: absent → fallback; present but
 * wrong → whole-file invalid (spec §13: config error → defaults + note).
 */
function scalarField<T>(
  scope: { [key: string]: YamlValue },
  key: string,
  label: string,
  check: (raw: YamlValue) => T | null,
  fallback: T,
): FieldOutcome<T> {
  const raw = scope[key]
  if (raw === undefined) return { ok: true, value: fallback }
  const value = check(raw)
  if (value === null) {
    return {
      ok: false,
      note: `note: .repolens.yml has an invalid ${label} — using default configuration`,
    }
  }
  return { ok: true, value }
}

/**
 * Parses and validates `.repolens.yml` content. Never throws: any
 * parse/validation failure yields the defaults with `status: 'invalid'`
 * and a one-line note (spec §10, §13).
 */
export function parseRepolensYml(input: string): ConfigParseResult {
  let parsed: YamlValue
  try {
    parsed = parseYamlSubset(input)
  } catch {
    return invalidResult(
      'note: .repolens.yml is unparseable — using default configuration',
    )
  }

  const root = asRecord(parsed)
  if (!root) {
    return invalidResult(
      'note: .repolens.yml is unparseable — using default configuration',
    )
  }
  if (root.version !== undefined && root.version !== 1) {
    return invalidResult(
      'note: .repolens.yml has an unsupported version — using default configuration',
    )
  }

  const onboardingRaw =
    root.onboarding === undefined ? {} : asRecord(root.onboarding)
  const reviewRaw = root.review === undefined ? {} : asRecord(root.review)
  if (!onboardingRaw || !reviewRaw) {
    return invalidResult(
      'note: .repolens.yml has invalid sections — using default configuration',
    )
  }

  const onboardingEnabled = scalarField(
    onboardingRaw,
    'enabled',
    'onboarding.enabled',
    asBoolean,
    DEFAULT_REPOLENS_CONFIG.onboarding.enabled,
  )
  if (!onboardingEnabled.ok) return invalidResult(onboardingEnabled.note)
  const onboardingSummary = scalarField(
    onboardingRaw,
    'summary',
    'onboarding.summary',
    asSummaryMode,
    DEFAULT_REPOLENS_CONFIG.onboarding.summary,
  )
  if (!onboardingSummary.ok) return invalidResult(onboardingSummary.note)
  const reviewEnabled = scalarField(
    reviewRaw,
    'enabled',
    'review.enabled',
    asBoolean,
    DEFAULT_REPOLENS_CONFIG.review.enabled,
  )
  if (!reviewEnabled.ok) return invalidResult(reviewEnabled.note)
  const maxDiffLines = scalarField(
    reviewRaw,
    'max_diff_lines',
    'review.max_diff_lines',
    (raw) => asBoundedInt(raw, MAX_DIFF_LINES_CAP),
    DEFAULT_REPOLENS_CONFIG.review.maxDiffLines,
  )
  if (!maxDiffLines.ok) return invalidResult(maxDiffLines.note)
  const maxFileLines = scalarField(
    reviewRaw,
    'max_file_lines',
    'review.max_file_lines',
    (raw) => asBoundedInt(raw, MAX_FILE_LINES_CAP),
    DEFAULT_REPOLENS_CONFIG.review.maxFileLines,
  )
  if (!maxFileLines.ok) return invalidResult(maxFileLines.note)

  const excludeRaw = root.exclude
  let exclude: string[]
  if (excludeRaw === undefined) {
    exclude = [] // `exclude:` is optional; empty when omitted
  } else {
    const checked = asExcludeList(excludeRaw)
    if (checked === null) {
      return invalidResult(
        'note: .repolens.yml has an invalid exclude list — using default configuration',
      )
    }
    exclude = checked
  }

  return {
    status: 'ok',
    note: null,
    config: {
      version: 1,
      onboarding: {
        enabled: onboardingEnabled.value,
        summary: onboardingSummary.value,
      },
      review: {
        enabled: reviewEnabled.value,
        maxDiffLines: maxDiffLines.value,
        maxFileLines: maxFileLines.value,
      },
      exclude,
    },
  }
}

function invalidResult(note: string): ConfigParseResult {
  return {
    status: 'invalid',
    note,
    config: structuredClone(DEFAULT_REPOLENS_CONFIG),
  }
}

/**
 * Loads config from optional file content. Missing file = all defaults
 * on without a note (spec §10).
 */
export function loadRepolensConfig(
  fileContent: string | undefined,
): ConfigParseResult {
  if (fileContent === undefined) {
    return {
      status: 'missing',
      note: null,
      config: structuredClone(DEFAULT_REPOLENS_CONFIG),
    }
  }
  if (fileContent.length > MAX_PARSED_BYTES_CONFIG) {
    return invalidResult(
      'note: .repolens.yml is too large — using default configuration',
    )
  }
  return parseRepolensYml(fileContent)
}
