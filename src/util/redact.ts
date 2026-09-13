/**
 * Secret redaction (spec §11): strips obvious secret-like strings from
 * content before it leaves the Worker for the LLM provider. Runs on the
 * assembled prompt (metadata + diff) so leaked credentials inside diffs
 * never reach a third party.
 *
 * Deliberate ceiling (Ponytail): regex-based only — catches common token
 * formats, key/value assignments, and PEM key blocks. Long values assigned
 * to token-ish identifiers may be redacted conservatively (false
 * positives are acceptable; missed exotic encodings are not caught).
 * Upgrade path: a scanning pass or provider-side DLP; not needed for v0.1.
 */

type RedactionRule = {
  pattern: RegExp
  /** Keep capture group 1 (the `key=` part) and replace only the value. */
  keepPrefix: boolean
}

const RULES: RedactionRule[] = [
  // PEM / TLS private key blocks (any line-based armor).
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    keepPrefix: false,
  },
  // Provider token formats (GitHub, AWS, Google, Slack, npm…).
  {
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|sk-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{15,}|npm_[A-Za-z0-9]{30,})\b/g,
    keepPrefix: false,
  },
  // Authorization headers (Bearer/Basic scheme + credential).
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    keepPrefix: false,
  },
  // Generic key=value / key: value assignments (quoted or bare values).
  // The key may be an identifier fragment (DB_PASSWORD, authToken…); the
  // bare-value alternative excludes code punctuation like (){}<> so that
  // ordinary expressions (`token: string`) are left alone.
  {
    pattern:
      /\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9_./+=-]{8,})/gi,
    keepPrefix: true,
  },
]

/** Fixed replacement so the model sees redaction, not empty space. */
const REPLACEMENT = '[REDACTED]'

/**
 * Replaces secret-like strings with `[REDACTED]`. Idempotent: running it
 * on already-redacted text changes nothing (the replacement contains no
 * key-like prefixes).
 */
export function redactSecrets(input: string): string {
  let output = input
  for (const rule of RULES) {
    output = output.replace(rule.pattern, (_match, ...captures) => {
      const prefix =
        rule.keepPrefix && typeof captures[0] === 'string'
          ? (captures[0] as string)
          : ''
      return prefix + REPLACEMENT
    })
  }
  return output
}
