/**
 * Gemini Flash adapter (spec §4, §11): implements `LLMProvider` against
 * the Google Generative Language REST API using `fetchImpl` injection
 * (tests mock every LLM call — hard rule, spec §12).
 *
 * Error messages carry status only; API response bodies are never logged
 * or embedded (they could echo untrusted content, spec §13). JSON error
 * parsing is defensive: malformed error bodies degrade to a status-only
 * message.
 */

import { LLMError } from '../errors'
import { fetchWithRetry } from '../util/retry'
import type { LLMProvider } from './provider'

const DEFAULT_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'

/** Conservative request cap so one job cannot ship huge payloads. */
const MAX_PROMPT_CHARS = 500_000

/** Wall-clock budget for one LLM call (spec §13: LLM timeout → degrade). */
const LLM_TIMEOUT_MS = 25_000

/** Gemini-layer typed error (extends the shared LLM taxonomy). */
export class LlmError extends LLMError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'LlmError'
  }
}

export type GeminiProviderOptions = {
  apiKey: string
  endpoint?: string
  fetchImpl?: typeof fetch
}

type GeminiApiResponse = {
  candidates?: { content?: { parts?: { text?: unknown }[] } }[]
}

function extractText(data: GeminiApiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const texts: string[] = []
  for (const part of parts) {
    if (typeof part.text === 'string') texts.push(part.text)
  }
  const text = texts.join('')
  if (text.trim().length === 0) {
    throw new LlmError(0, 'gemini response contained no text')
  }
  return text
}

/** Creates the Gemini Flash provider. Single call per job (spec §14). */
export function createGeminiProvider(
  options: GeminiProviderOptions,
): LLMProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT

  return {
    async complete(input: string): Promise<string> {
      if (input.length > MAX_PROMPT_CHARS) {
        throw new LlmError(0, 'prompt exceeds hard character cap')
      }
      let response: Response
      try {
        response = await fetchWithRetry(fetchImpl, endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': options.apiKey,
          },
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          body: JSON.stringify({
            // v0.1: one logical call, no thinking budget, modest output cap.
            generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
            contents: [{ role: 'user', parts: [{ text: input }] }],
          }),
        })
      } catch {
        throw new LlmError(0, 'gemini request failed (network error)')
      }
      if (!response.ok) {
        throw new LlmError(
          response.status,
          `gemini request failed with status ${response.status}`,
        )
      }
      const data = (await response.json()) as GeminiApiResponse
      return extractText(data)
    },
  }
}
