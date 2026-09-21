/**
 * LE DUE SBARRE DELLA CONSOLE DI PIATTAFORMA.
 *
 * Qui si entra per creare, sospendere e CANCELLARE i tenant: è l'unico posto
 * del prodotto dove un errore di autorizzazione non danneggia un cliente ma
 * tutti. Per questo il confine non è un permesso — che si può dimenticare di
 * verificare — ma l'emittente del token, e questi test pinnano che entrambe le
 * sbarre esistano e che nessuna delle due basti da sola.
 *
 * Il caso peggiore che chiudono: un amministratore di `c-test` che prova ad
 * arrivare ai dati di `c-one` passando dalla console.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type express from 'express'

/** Il token che `verifyKeycloakToken` restituisce: lo decide ogni caso. */
let payload: Record<string, unknown> | null = null
let verificaEsplode = false

vi.mock('../keycloak.js', () => ({
  verifyKeycloakToken: vi.fn(async () => {
    if (verificaEsplode) throw new Error('firma non valida')
    return payload
  }),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
  authLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

/** La configurazione: la console esiste solo se sono impostate entrambe. */
let realmConfigurato: string | undefined = 'opengrafo-platform'
let hostConfigurato: string | undefined = 'opengrafo-admin.localhost'
vi.mock('../../lib/config.js', () => ({
  config: {
    get platformRealm() { return realmConfigurato },
    get platformHost() { return hostConfigurato },
  },
}))

const { resolvePlatformActor } = await import('../platformAuth.js')

const richiesta = (host: string, token = 'un-token'): express.Request => ({
  headers: { 'x-forwarded-host': host, authorization: `Bearer ${token}` },
} as unknown as express.Request)

beforeEach(() => {
  realmConfigurato = 'opengrafo-platform'
  hostConfigurato = 'opengrafo-admin.localhost'
  verificaEsplode = false
  payload = {
    iss: 'http://localhost:8080/realms/opengrafo-platform',
    email: 'chi.amministra@esempio.it',
    sub: 'utente-1',
  }
})

describe('chi entra nella console', () => {
  it('con realm di piattaforma E host della console: passa', async () => {
    const attore = await resolvePlatformActor(richiesta('opengrafo-admin.localhost'))
    expect(attore).toEqual({ email: 'chi.amministra@esempio.it', subject: 'utente-1' })
  })

  it('l\'host si confronta senza la porta e senza distinzione di maiuscole', async () => {
    await expect(resolvePlatformActor(richiesta('OpenGrafo-Admin.localhost:8443'))).resolves.toMatchObject({ subject: 'utente-1' })
  })

  it('una catena di proxy accoda più host: conta il PRIMO, quello che il client ha chiesto', async () => {
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost, interno:80'))).resolves.toBeTruthy()
  })
})

describe('la prima sbarra: il realm', () => {
  it('un token di un TENANT sulla console si rifiuta', async () => {
    // È il caso peggiore: l'admin di c-test che prova ad arrivare a c-one.
    payload = { iss: 'http://localhost:8080/realms/c-test', email: 'admin@c-test.it', sub: 'u2' }
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
  })

  it('un token con una firma non valida si rifiuta', async () => {
    verificaEsplode = true
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
  })

  it('un token senza email o senza sub si rifiuta: l\'azione va attribuita a qualcuno', async () => {
    payload = { iss: 'http://localhost:8080/realms/opengrafo-platform', sub: 'u1' }
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
    payload = { iss: 'http://localhost:8080/realms/opengrafo-platform', email: 'x@y.it' }
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
  })

  it('senza token si rifiuta', async () => {
    const req = { headers: { 'x-forwarded-host': 'opengrafo-admin.localhost' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).rejects.toThrow('Unauthorized')
  })
})

describe('la seconda sbarra: l\'host', () => {
  it('un token DI PIATTAFORMA su un host di tenant si rifiuta', async () => {
    // Senza questa sbarra, chi ottenesse un token di piattaforma potrebbe
    // usarlo su qualunque host: il confronto host↔realm che protegge i tenant
    // non lo vedrebbe nemmeno, perché quel realm non è un tenant.
    await expect(resolvePlatformActor(richiesta('c-one.localhost'))).rejects.toThrow('Unauthorized')
  })

  it('e su un host che somiglia a quello della console', async () => {
    for (const host of ['opengrafo-admin.evil.com', 'x-opengrafo-admin.localhost', 'opengrafo-admin.localhost.evil.com']) {
      await expect(resolvePlatformActor(richiesta(host)), host).rejects.toThrow('Unauthorized')
    }
  })
})

describe('senza configurazione la console NON ESISTE', () => {
  it('manca il realm: si rifiuta anche un token perfetto', async () => {
    realmConfigurato = undefined
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
  })

  it('manca l\'host: si rifiuta', async () => {
    hostConfigurato = undefined
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
  })

  it('mancano entrambi: si rifiuta — un default avrebbe aperto la console su ogni installazione', async () => {
    realmConfigurato = undefined
    hostConfigurato = undefined
    await expect(resolvePlatformActor(richiesta('opengrafo-admin.localhost'))).rejects.toThrow('Unauthorized')
  })
})

describe('il rifiuto non racconta quale sbarra ha fermato', () => {
  it('la frase è sempre la stessa: a chi prova a indovinare non si regala la mappa', async () => {
    const frasi: string[] = []
    const prova = async (req: express.Request) => {
      try { await resolvePlatformActor(req) } catch (e) { frasi.push((e as Error).message) }
    }
    await prova(richiesta('c-one.localhost'))                       // host sbagliato
    payload = { iss: 'http://localhost:8080/realms/c-test', email: 'a@b.it', sub: 'u' }
    await prova(richiesta('opengrafo-admin.localhost'))             // realm sbagliato
    realmConfigurato = undefined
    await prova(richiesta('opengrafo-admin.localhost'))             // non configurata
    expect(new Set(frasi).size).toBe(1)
    expect(frasi[0]).toBe('Unauthorized')
  })
})
