/**
 * Shared retry helper (spec §11, §14): retries transient failures
 * (429, 500, 502, 503, 504, network errors) with exponential backoff,
 * max 3 attempts total, honoring Retry-After when sane. Non-retryable
 * statuses return immediately. Never logs bodies; messages stay
 * status-only (spec §13).
 */

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export const MAX_ATTEMPTS = 3

/** Base backoff in ms; attempt n waits base * 2^n with ±25% jitter. */
const BASE_BACKOFF_MS = 200
/** Retry-After is honored only for sane values (≤ 30s). */
const MAX_RETRY_AFTER_SECONDS = 30

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (
    retryAfterSeconds !== null &&
    retryAfterSeconds > 0 &&
    retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
  ) {
    return retryAfterSeconds * 1000
  }
  const exponential = BASE_BACKOFF_MS * 2 ** attempt
  const jitter = exponential * (0.75 + Math.random() * 0.5)
  return Math.round(jitter)
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status)
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (header === null) return null
  const seconds = Number.parseInt(header, 10)
  return Number.isFinite(seconds) ? seconds : null
}

export type FetchWithRetryOptions = {
  /** Injectable sleep for tests (delays are never awaited in tests). */
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
}

/**
 * Fetch with retry. Returns the (possibly failed) response only if its
 * status is not retryable, or the final attempt's response otherwise —
 * callers keep their existing !response.ok handling. Network errors
 * retry, then rethrow the (opaque) network failure.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const sleep = options.sleep ?? DEFAULT_SLEEP
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS

  let delayMs = 0
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(delayMs)
    }
    try {
      const response = await fetchImpl(url, init)
      if (!isRetryableStatus(response.status)) {
        return response
      }
      if (attempt === maxAttempts - 1) {
        return response // final attempt: let the caller see the failure
      }
      delayMs = backoffMs(
        attempt,
        response.status === 429 ? retryAfterSeconds(response) : null,
      )
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error
      delayMs = backoffMs(attempt, null)
    }
  }
  throw new Error('unreachable') // loop always returns or throws
}
