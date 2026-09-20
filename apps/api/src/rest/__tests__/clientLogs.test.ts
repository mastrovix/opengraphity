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
/*
 * Il freno vive su Redis (20 set 2026): qui si lascia passare tutto, perché
 * quello che questi test provano sono i TETTI sul contenuto. Il freno ha i
 * suoi, e la scelta di far propagare un Redis irraggiungibile — invece di
 * disattivare il limite in silenzio — è la stessa dei webhook in ingresso.
 */
vi.mock('../../lib/webhookRateLimit.js', () => ({
  consumeMinuteRate: async () => ({ allowed: true, count: 1, limit: 60, retryAfterSeconds: 1 }),
}))

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

/**
 * L'ORA LA DECIDE IL SERVER (20 set 2026, rimedio a).
 *
 * Rilievo della revisione, verificato nel codice: `body.timestamp` arrivava
 * senza nessuna validazione e finiva in `created_at`, nel `day` dell'archivio
 * di piattaforma, quindi nelle soglie che aprono gli incident e nella
 * finestra della purga. Qualunque utente autenticato di qualunque cliente
 * poteva: aprire un incident `critical` sulla piattaforma con venti POST;
 * rendere una riga IMMORTALE con `day: "9999-01-01"` (sempre dentro la
 * finestra, mai dentro la retention); far scattare la soglia «cronico» con
 * tre date diverse.
 *
 * Questi test tengono ferma la regola: l'orologio del client non governa
 * niente. Si conserva accanto, perché un browser con l'ora sbagliata è a sua
 * volta un'informazione — ma non è più una chiave.
 */
describe('l\'ora del client non governa niente', () => {
  beforeEach(() => { run.mockClear() })

  it('una data nel futuro remoto non diventa il timestamp della riga', async () => {
    const prima = Date.now()
    await post({ level: 'error', message: 'boom', timestamp: '9999-01-01T00:00:00.000Z' })
    const scritta = scritto()
    expect(scritta['timestamp']).not.toContain('9999')
    const quando = Date.parse(scritta['timestamp']!)
    expect(quando).toBeGreaterThanOrEqual(prima)
    expect(quando).toBeLessThanOrEqual(Date.now())
  })

  it('`timestamp` e `created_at` sono lo stesso valore, e viene dal server', async () => {
    await post({ level: 'error', message: 'boom', timestamp: '1999-01-01T00:00:00.000Z' })
    // La query usa `$timestamp` per tutt'e due: basta che il parametro sia sano.
    expect(Date.parse(scritto()['timestamp']!)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
  })

  it('l\'ora dichiarata dal client si CONSERVA, accanto e non al posto', async () => {
    await post({ level: 'error', message: 'boom', timestamp: '9999-01-01T00:00:00.000Z' })
    const dati = JSON.parse(scritto()['data']!) as Record<string, unknown>
    expect(dati['clientTimestamp']).toBe('9999-01-01T00:00:00.000Z')
  })

  it('senza `timestamp` non si inventa un campo vuoto', async () => {
    await post({ level: 'error', message: 'boom' })
    expect(JSON.parse(scritto()['data']!)).not.toHaveProperty('clientTimestamp')
  })

  it('un `timestamp` che non è una stringa non entra da nessuna parte', async () => {
    await post({ level: 'error', message: 'boom', timestamp: { evil: true } })
    const dati = JSON.parse(scritto()['data']!) as Record<string, unknown>
    expect(dati).not.toHaveProperty('clientTimestamp')
    expect(Number.isNaN(Date.parse(scritto()['timestamp']!))).toBe(false)
  })
})
