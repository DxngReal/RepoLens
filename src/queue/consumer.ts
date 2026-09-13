/**
 * Queue consumer (spec §5, §14): processes onboarding_job and review_job
 * messages produced by the webhook route.
 *
 * Failure policy (spec §13): GitHub/LLM failures → one safe log line +
 * `message.retry()` (redelivery up to the consumer's max_retries, then
 * the message is dropped — we post nothing rather than a half-result).
 * Poison messages (invalid shape) are acked, never retried forever.
 *
 * Sequential processing, small batches — no fan-out bursts (spec §14).
 * The LLM provider is built per message from env; a missing GEMINI_API_KEY
 * degrades the review to deterministic-only (honest footer, spec §11).
 */

import { runOnboardingJob } from '../analyze/onboarding'
import { runReviewJob } from '../analyze/review'
import type { Env } from '../env'
import { logSafe } from '../errors'
import { createGeminiProvider } from '../llm/gemini'
import type { LLMProvider } from '../llm/provider'

export type OnboardingJobMessage = {
  type: 'onboarding_job'
  installationId: number
  owner: string
  repo: string
}

export type ReviewJobMessage = {
  type: 'review_job'
  installationId: number
  owner: string
  repo: string
  number: number
}

export type QueueMessage = OnboardingJobMessage | ReviewJobMessage

/** Strict, allow-listed shape validation for queue payloads. */
export function parseQueueMessage(raw: unknown): QueueMessage | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const { type } = record
  if (
    typeof record.installationId !== 'number' ||
    typeof record.owner !== 'string' ||
    record.owner.length === 0 ||
    typeof record.repo !== 'string' ||
    record.repo.length === 0
  ) {
    return null
  }
  if (type === 'onboarding_job') {
    return {
      type,
      installationId: record.installationId,
      owner: record.owner,
      repo: record.repo,
    }
  }
  if (type === 'review_job') {
    if (typeof record.number !== 'number' || record.number <= 0) return null
    return {
      type,
      installationId: record.installationId,
      owner: record.owner,
      repo: record.repo,
      number: record.number,
    }
  }
  return null
}

/** LLM provider from env; undefined → deterministic-only review. */
export function buildReviewProvider(env: Env): LLMProvider | undefined {
  if (
    typeof env.GEMINI_API_KEY !== 'string' ||
    env.GEMINI_API_KEY.length === 0
  ) {
    return undefined
  }
  return createGeminiProvider({ apiKey: env.GEMINI_API_KEY })
}

export type MessageOutcome = 'ack' | 'retry'

/**
 * Handles one queue message body. Returns 'ack' (done or poison) or
 * 'retry' (transient failure — the whole job failed before posting).
 */
export async function handleQueueMessage(
  env: Env,
  raw: unknown,
): Promise<MessageOutcome> {
  const message = parseQueueMessage(raw)
  if (message === null) {
    console.log('queue: dropped invalid message')
    return 'ack'
  }
  try {
    if (message.type === 'onboarding_job') {
      const result = await runOnboardingJob(env, message)
      if (result.status === 'posted') {
        console.log(`queue: onboarding issue posted (#${result.issueNumber})`)
      } else {
        console.log(`queue: onboarding skipped (${result.reason ?? 'unknown'})`)
      }
    } else {
      const result = await runReviewJob(env, message, {
        provider: buildReviewProvider(env),
      })
      if (result.status === 'posted') {
        console.log(
          `queue: review comment posted${result.degraded ? ' (degraded)' : ''}`,
        )
      } else {
        console.log(`queue: review skipped (${result.reason ?? 'unknown'})`)
      }
    }
    return 'ack'
  } catch (error: unknown) {
    // One safe line; error text may carry untrusted content (spec §13),
    // so only the typed error name + numeric status are logged.
    console.log(
      logSafe(['queue: job errored', message.type, { error }, 'will retry']),
    )
    return 'retry'
  }
}

/** Workers Queue handler (spec §5): sequential, small batches. */
export default {
  async queue(
    batch: {
      messages: readonly { body: unknown; ack: () => void; retry: () => void }[]
    },
    env: Env,
  ) {
    for (const message of batch.messages) {
      const outcome = await handleQueueMessage(env, message.body)
      if (outcome === 'retry') {
        message.retry()
      } else {
        message.ack()
      }
    }
  },
}
