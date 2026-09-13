/**
 * Error taxonomy + safe logging (spec §13; MASTER_BUILD_PROMPT §5:
 * src/errors.ts — typed errors, safe logging).
 *
 * Every module throws its layer's typed error; the message is status or
 * fixed words only — never a response body, payload text, or content that
 * could echo untrusted data (spec §13). Log lines go through logSafe()
 * so callers can include a request id without risking content leakage.
 */

/**
 * Typed error for the GitHub layer: status 0 means a local validation
 * failure (bad shape/truncated response); otherwise the HTTP status.
 * Message is status/field-only, never a response body.
 */
export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Typed error for the LLM layer (same message discipline). */
export class LLMError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LLMError'
  }
}

/**
 * Bounded, single-line field: control characters (incl. newlines) are
 * flattened so a hostile value can never forge extra log lines, and the
 * length is capped. Applies to every string part of logSafe — the single
 * choke point for log-injection defense (spec §13 hardened logging).
 */
const MAX_LOG_FIELD_CHARS = 200

function sanitizeLogField(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control chars is the whole point (log-injection defense)
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  return flattened.slice(0, MAX_LOG_FIELD_CHARS)
}

/**
 * Builds one safe log line: joins fixed parts, and flattens any error to
 * `name (status)`. Error messages may in principle carry untrusted
 * content, so only the typed name + numeric status are ever logged
 * (spec §13: status-only, no bodies, no payloads). Never throws.
 */
export function logSafe(
  parts: (string | number | { error: unknown })[],
): string {
  const rendered = parts.map((part) => {
    if (typeof part === 'object' && part !== null && 'error' in part) {
      const error = part.error
      if (error instanceof Error) {
        const status =
          typeof (error as { status?: unknown }).status === 'number'
            ? ` status ${(error as { status?: unknown }).status as number}`
            : ''
        return `${error.name}${status}`
      }
      return 'unknown-error'
    }
    return typeof part === 'string' ? sanitizeLogField(part) : String(part)
  })
  return rendered.join(' ')
}
