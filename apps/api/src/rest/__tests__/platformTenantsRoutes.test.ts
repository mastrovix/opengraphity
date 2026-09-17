/**
 * LE ROTTE DELLA CONSOLE DI PIATTAFORMA, su un Express vero.
 *
 * Quello che si pinna qui è il MODO DELLA SESSIONE, e per un motivo preciso:
 * `getSession()` apre in SOLA LETTURA per default, e le rotte che scrivono
 * (rinomina, sospendi, riattiva, cancella) sono nate su quel default. Il
 * risultato era un 500 con «Writing in read access mode not allowed» al primo
 * clic su Suspend — e la creazione funzionava, perché passa da
 * `tenantOnboarding` che apre la sua sessione in scrittura. Cioè: il difetto
 * colpiva solo le azioni su un tenant che esiste già, che sono tutte quelle
 * che la console fa dopo il primo giorno (17 set 2026).
 *
 * Un test così vale più di una lettura attenta: il modo sbagliato non si vede
 * nel codice, si vede solo quando la query prova a scrivere.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v) }))
// L'autenticazione ha i suoi test (`auth/__tests__/platformAuth.test.ts`): qui
// l'attore c'è, così le rotte si possono esercitare senza un Keycloak.
vi.mock('../../auth/platformAuth.js', () => ({
  platformAuthMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.platformActor = { email: 'admin@piattaforma.example', sub: 'sub-1' }
    next()
  },
}))
const lifecycle = {
  listTenants:     vi.fn(async () => [{ id: 'acme', slug: 'acme', name: 'ACME' }]),
  tenantFootprint: vi.fn(async () => ({ Incident: 3 })),
  renameTenant:    vi.fn(async () => {}),
  suspendTenant:   vi.fn(async () => {}),
  resumeTenant:    vi.fn(async () => {}),
  purgeTenant:     vi.fn(async () => ({ nodiCancellati: 3, realmCancellato: true })),
  assertSlugValido: vi.fn(),
}
vi.mock('../../lib/tenantLifecycle.js', () => lifecycle)
vi.mock('../../scripts/lib/keycloakAdmin.js', () => ({
  createKeycloakAdmin: () => ({ getAdminToken: async () => 't', delete: async () => {} }),
  keycloakConfigFromEnv: () => ({}),
}))

const { getSession } = await import('@opengraphity/neo4j')
const { platformTenantsRouter } = await import('../platform-tenants.js')

let server: Server
let base: string
const session = { close: vi.fn().mockResolvedValue(undefined) }

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(platformTenantsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/tenants`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

/** I modi con cui la rotta ha chiesto una sessione, nell'ordine. */
function modi(): string[] {
  return vi.mocked(getSession).mock.calls.map((c) => String(c[1] ?? 'READ (default)'))
}

const patch = (slug: string, body: unknown) =>
  fetch(`${base}/${slug}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('le rotte che SCRIVONO chiedono una sessione di scrittura', () => {
  it('rinomina', async () => {
    const res = await patch('acme', { action: 'rename', name: 'ACME Due' })
    expect(res.status).toBe(200)
    expect(lifecycle.renameTenant).toHaveBeenCalledWith(session, 'acme', 'ACME Due')
    // La prima sessione è quella della scrittura; la seconda rilegge l'elenco.
    expect(modi()[0]).toBe('WRITE')
  })

  it('sospensione', async () => {
    const res = await patch('acme', { action: 'suspend' })
    expect(res.status).toBe(200)
    expect(modi()[0]).toBe('WRITE')
  })

  it('riattivazione', async () => {
    const res = await patch('acme', { action: 'resume' })
    expect(res.status).toBe(200)
    expect(modi()[0]).toBe('WRITE')
  })

  it('cancellazione definitiva', async () => {
    const res = await fetch(`${base}/acme`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'acme' }),
    })
    expect(res.status).toBe(200)
    expect(modi()).toEqual(['WRITE'])
  })
})

describe('le rotte che LEGGONO non chiedono la scrittura', () => {
  it('elenco', async () => {
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(modi()).toEqual(['READ (default)'])
  })

  it('impronta', async () => {
    const res = await fetch(`${base}/acme/footprint`)
    expect(res.status).toBe(200)
    expect(modi()).toEqual(['READ (default)'])
  })
})

describe('i rifiuti non aprono nulla e dicono cosa manca', () => {
  it('un\'azione sconosciuta è 400, e nessuna sessione', async () => {
    const res = await patch('acme', { action: 'esplodi' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('rename') })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('una rinomina senza nome è 400', async () => {
    const res = await patch('acme', { action: 'rename' })
    expect(res.status).toBe(400)
    expect(lifecycle.renameTenant).not.toHaveBeenCalled()
  })

  it('una cancellazione senza `confirm` è 400: la sbarra sta prima della sessione', async () => {
    const res = await fetch(`${base}/acme`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('la sessione si chiude anche quando la scrittura fallisce', () => {
  it('un errore di `suspendTenant` non lascia la sessione aperta', async () => {
    lifecycle.suspendTenant.mockRejectedValueOnce(new Error('tenant "acme" is not suspended'))
    const res = await patch('acme', { action: 'suspend' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(session.close).toHaveBeenCalled()
    // E il corpo porta un MESSAGGIO: la console lo mostra così com'è, e un
    // corpo senza messaggio le faceva scrivere «[object Object]».
    const body = await res.json() as { error?: { message?: string } }
    expect(body.error?.message).toBeTruthy()
  })
})
