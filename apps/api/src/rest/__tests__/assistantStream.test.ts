/**
 * POST /api/assistant/stream (ondata 7 di «Nulla cablato»): prima bastava il
 * login, e un utente del portale poteva chiedere all'assistente gli incident
 * di tutta l'organizzazione. Ora serve `assistant.use`, e il servizio riceve i
 * permessi del ruolo per scegliere gli strumenti.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { perms } from '../../lib/__tests__/testPermissions.js'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../services/assistantService.js', () => ({ streamAssistantChat: vi.fn() }))
/**
 * Il limite per persona dell'assistente passa da Redis (revisione totale ·
 * D-27): qui si finge «passa», e un test suo verifica il rifiuto.
 */
vi.mock('../../lib/webhookRateLimit.js', () => ({
  consumeMinuteRate: vi.fn(async () => ({ allowed: true, count: 1, limit: 20, retryAfterSeconds: 60 })),
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = typeof req.headers['x-test-role'] === 'string' ? req.headers['x-test-role'] : 'operator'
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role, permissions: perms(role) }
    next()
  },
}))

const { streamAssistantChat } = await import('../../services/assistantService.js')
const { assistantRouter } = await import('../assistant.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', assistantRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant/stream`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(streamAssistantChat).mockImplementation(async (_t, _p, _m, emit) => { emit.done('ok') })
})

const post = (role: string) => fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-test-role': role },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'quanti incident aperti?' }] }),
})

describe('POST /api/assistant/stream — permesso assistant.use', () => {
  it('utente del portale (senza assistant.use) → 403 JSON, nessuna chiamata al modello', async () => {
    const res = await post('end_user')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Role 'end_user' is not authorized. Requires: assistant.use" })
    expect(streamAssistantChat).not.toHaveBeenCalled()
  })

  it('viewer (con assistant.use) → stream, e il servizio riceve i permessi del ruolo', async () => {
    const res = await post('viewer')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    await res.text()
    const [tenantId, permissions] = vi.mocked(streamAssistantChat).mock.calls[0]!
    expect(tenantId).toBe('tenant-1')
    expect([...permissions]).toContain('incident.read')
    expect([...permissions]).not.toContain('incident.write')
  })
})

/**
 * D-27: `assistant.use` è anche del viewer e ogni richiesta rimanda l'intera
 * conversazione al modello, quindi senza tetto la spesa era illimitata. Il
 * limite è per persona e per minuto, con la stessa forma di quello dei
 * webhook: qui si verifica che il rifiuto arrivi come 429 con `Retry-After`,
 * e che il modello non venga chiamato affatto.
 */
describe('POST /api/assistant/stream — tetto per persona (D-27)', () => {
  it('limite superato → 429 con Retry-After, il modello non viene chiamato', async () => {
    const { consumeMinuteRate } = await import('../../lib/webhookRateLimit.js')
    vi.mocked(consumeMinuteRate).mockResolvedValueOnce({ allowed: false, count: 21, limit: 20, retryAfterSeconds: 42 })
    const res = await post('operator')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retry_after: 42 } })
    expect(streamAssistantChat).not.toHaveBeenCalled()
  })
})
