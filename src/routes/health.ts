import { Hono } from 'hono'

/**
 * GET /healthz — liveness probe (spec §5).
 *
 * Deliberately reports nothing about configuration state: no secrets,
 * no binding details, just "the Worker is up".
 */
export const health = new Hono()

health.get('/healthz', (c) => c.json({ ok: true, service: 'repolens' }))
