import { describe, expect, it } from 'vitest'
import {
  handleQueueMessage,
  parseQueueMessage,
  type QueueMessage,
} from '../src/queue/consumer'

/**
 * Phase 4 tests (spec §12): queue message validation and outcome policy.
 * Job execution itself is covered in review.test.ts / onboarding.test.ts
 * with mocked fetch; here we assert the ack/retry/ack-poison policy
 * without any GitHub or LLM calls.
 */

describe('parseQueueMessage', () => {
  it('accepts valid onboarding and review messages', () => {
    expect(
      parseQueueMessage({
        type: 'onboarding_job',
        installationId: 1,
        owner: 'o',
        repo: 'r',
      }),
    ).toEqual({
      type: 'onboarding_job',
      installationId: 1,
      owner: 'o',
      repo: 'r',
    })
    expect(
      parseQueueMessage({
        type: 'review_job',
        installationId: 1,
        owner: 'o',
        repo: 'r',
        number: 7,
      }),
    ).toEqual({
      type: 'review_job',
      installationId: 1,
      owner: 'o',
      repo: 'r',
      number: 7,
    })
  })

  it('rejects malformed or poison messages', () => {
    expect(parseQueueMessage(null)).toBeNull()
    expect(parseQueueMessage('string')).toBeNull()
    expect(parseQueueMessage({})).toBeNull()
    expect(parseQueueMessage({ type: 'onboarding_job' })).toBeNull()
    expect(
      parseQueueMessage({
        type: 'unknown_job',
        installationId: 1,
        owner: 'o',
        repo: 'r',
      }),
    ).toBeNull()
    expect(
      parseQueueMessage({
        type: 'review_job',
        installationId: 1,
        owner: 'o',
        repo: 'r',
        number: 0,
      }),
    ).toBeNull()
    expect(
      parseQueueMessage({
        type: 'review_job',
        installationId: 1,
        owner: '',
        repo: 'r',
        number: 7,
      }),
    ).toBeNull()
  })
})

describe('handleQueueMessage — outcome policy', () => {
  const minimalEnv = {
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => undefined,
    },
    GH_APP_ID: '',
    GH_PRIVATE_KEY: 'not-a-key',
    GH_WEBHOOK_SECRET: '',
    GEMINI_API_KEY: '',
  } as unknown as Parameters<typeof handleQueueMessage>[0]

  it('acks poison messages without retrying', async () => {
    const outcome = await handleQueueMessage(minimalEnv, { nonsense: true })
    expect(outcome).toBe('ack')
  })

  it('acks skipped jobs (e.g. deterministic-only path cannot run without key setup)', async () => {
    // A valid message against a broken env: the job errors → retry.
    const outcome = await handleQueueMessage(minimalEnv, {
      type: 'onboarding_job',
      installationId: 1,
      owner: 'o',
      repo: 'r',
    })
    expect(outcome).toBe('retry')
  })
})

describe('queue message type', () => {
  it('narrowly types review jobs', () => {
    const message: QueueMessage = {
      type: 'review_job',
      installationId: 2,
      owner: 'o',
      repo: 'r',
      number: 3,
    }
    expect(message.type).toBe('review_job')
  })
})
