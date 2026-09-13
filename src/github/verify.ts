/**
 * X-Hub-Signature-256 verification (spec §7).
 *
 * GitHub signs each webhook payload with HMAC-SHA256 using the app's
 * webhook secret and sends it as `sha256=<hexdigest>`. Every delivery
 * must be verified before any processing; missing/invalid → 401.
 * Comparison is done on hex digests with a constant-time loop.
 */

const encoder = new TextEncoder()

/** Constant-time equality for equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  let hex = ''
  for (const byte of new Uint8Array(mac)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Returns true iff `signatureHeader` is a valid `sha256=` HMAC of the raw
 * payload with `secret`. Missing secret/header or malformed header → false.
 */
export async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string | null | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!signatureHeader || !secret) {
    return false
  }
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim())
  if (!match) {
    return false
  }
  const expected = await hmacSha256Hex(payload, secret)
  return timingSafeEqualHex(expected, match[1].toLowerCase())
}
