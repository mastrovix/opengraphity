/**
 * Un log del browser ha una dimensione MASSIMA (revisione totale · M-24).
 *
 * Non c'era nessun tetto oltre a quello del parser JSON di express: un client
 * (o una pagina con un errore in un ciclo) poteva riempire Neo4j di `LogEntry`
 * da mezzo mega. Il taglio si vede — `… [troncato]` — perché un log tagliato in
 * silenzio è peggio di uno tagliato dichiarato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn(async () => ({ records: [] }))
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeWrite: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    close,
  }),
}))
vi.mock('../../middleware/auth.js', () => ({ authMiddleware: (_r: unknown, _s: unknown, next: () => void) => next() }))

const { clientLogRouter } = await import('../client-logs.js')

/** Il solo handler del router, chiamato con una richiesta finta. */
function handler(): (req: unknown, res: unknown, next: unknown) => Promise<void> {
  const layer = (clientLogRouter as unknown as { stack: { route?: { path: string; stack: { handle: unknown }[] } }[] })
    .stack.find((l) => l.route?.path === '/logs/client')
  // [authMiddleware, asyncHandler(handleClientLog)]
  return layer!.route!.stack[1]!.handle as (req: unknown, res: unknown, next: unknown) => Promise<void>
}

function fakeRes() {
  const res = {
    statusCode: 0, body: undefined as unknown,
    status(c: number) { res.statusCode = c; return res },
    json(b: unknown) { res.body = b; return res },
    end() { return res },
  }
  return res
}

async function post(body: unknown) {
  const res = fakeRes()
  await handler()({ body, user: { tenantId: 'c-test', userId: 'u1' } }, res, () => undefined)
  return res
}

const scritto = () => (run.mock.calls.at(-1)?.[1] ?? {}) as Record<string, string>

describe('POST /api/logs/client', () => {
  beforeEach(() => { run.mockClear() })

  it('taglia un messaggio enorme invece di scriverlo intero (e invece di rifiutarlo)', async () => {
    const res = await post({ level: 'error', message: 'x'.repeat(50_000) })
    expect(res.statusCode).toBe(204)
    const m = scritto()['message']!
    expect(m.length).toBeLessThanOrEqual(4_000)
    expect(m.endsWith('… [troncato]')).toBe(true)
  })

  it('taglia anche stack, url e dati di contesto', async () => {
    await post({ level: 'warn', message: 'ok', stack: 's'.repeat(50_000), url: 'u'.repeat(50_000), data: { k: 'v'.repeat(50_000) } })
    const d = scritto()['data']!
    expect(d.length).toBeLessThanOrEqual(8_000)
    expect(d.endsWith('… [troncato]')).toBe(true)
  })

  it('un messaggio che non è una stringa è un errore del client, non «[object Object]» nel grafo', async () => {
    const res = await post({ level: 'error', message: { oops: true } })
    expect(res.statusCode).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('un messaggio corto passa intero, senza segni di taglio', async () => {
    await post({ level: 'info', message: 'tutto bene' })
    expect(scritto()['message']).toBe('tutto bene')
  })
})
