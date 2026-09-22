/**
 * COME NASCE UN TENANT (22 set 2026).
 *
 * ## Perché non c'erano test
 * `lib/tenantOnboarding.ts` stava a ZERO: nessuna istruzione coperta. È il
 * cammino con la conseguenza peggiore di tutto il prodotto — se nasce male,
 * un cliente non entra affatto — e la sua intestazione elenca tre lezioni
 * GIÀ PAGATE:
 *
 * 1. la password si consegna nell'istante dopo averla impostata, perché una
 *    volta un passo successivo è crollato e il primo amministratore di un
 *    cliente vero è rimasto chiuso fuori senza rimedio;
 * 2. l'operazione è additiva e idempotente — niente di quello che trova viene
 *    riallineato, perché potrebbe essere una personalizzazione;
 * 3. con l'unica eccezione degli indirizzi di ritorno, che se mancano rendono
 *    il tenant irraggiungibile: quelli si AGGIUNGONO, e si dice.
 *
 * Tre frasi. Qui diventano tre prove.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Neo4j, finto ──────────────────────────────────────────────────────────────
const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  })),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))

const seedSystemEnumTypes = vi.fn().mockResolvedValue(undefined)
vi.mock('../seedEnumTypes.js', () => ({ seedSystemEnumTypes: (...a: unknown[]) => seedSystemEnumTypes(...a) }))

const provisionTenantData = vi.fn()
vi.mock('../provisionTenantData.js', () => ({ provisionTenantData: (...a: unknown[]) => provisionTenantData(...a) }))

const findUserIdByEmail = vi.fn(async () => 'kc-user-esistente')
vi.mock('../../scripts/lib/keycloakAdmin.js', () => ({
  findUserIdByEmail: (...a: unknown[]) => findUserIdByEmail(...a),
}))

const { onboardTenant } = await import('../tenantOnboarding.js')
const { USERS_ADMIN_PERMISSION } = await import('@opengraphity/types')

// ── il Keycloak finto ─────────────────────────────────────────────────────────
function keycloak(over: Record<string, unknown> = {}) {
  return {
    getAdminToken: vi.fn(async () => 'tok'),
    post: vi.fn(async () => ({ created: true, id: 'kc-user-nuovo' })),
    get: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    ...over,
  }
}

const spec = (over: Record<string, unknown> = {}) => ({
  slug: 'c-uno', tenantName: 'Cliente Uno', plan: 'pro' as const, timezone: 'Europe/Rome',
  email: 'admin@c-uno.it', firstName: 'Ada', lastName: 'Byron', adminRole: 'admin',
  domain: 'opengrafo.it', production: false, piIp: undefined, ...over,
}) as never

const password = { value: 'segreto-finto', temporary: true }

/** Tutti gli indirizzi che l'onboarding di sviluppo vuole, web e portale insieme. */
const RITORNI_COMPLETI = [
  'https://c-uno.opengrafo.it/*', 'http://c-uno.localhost/*', 'http://c-uno.localhost:5173/*',
  'http://*.localhost/*', 'http://*.localhost:5173/*', 'http://*.localhost:8080/*',
  'https://portal.c-uno.opengrafo.it/*', 'http://portal.c-uno.localhost/*',
  'http://portal.c-uno.localhost:5174/*', 'http://*.localhost:5174/*', 'http://localhost:5174/*',
]

/** Le righe che le due MERGE e le due letture restituiscono, nell'ordine. */
function rispondiComeUnGrafoVuoto() {
  txRun.mockImplementation(async (cypher: string) => {
    const q = String(cypher)
    if (q.includes('MERGE (t:Tenant')) return { records: [{ get: () => true }] }
    if (q.includes('MERGE (u:User'))   return { records: [{ get: () => true }] }
    if (q.includes('MATCH (r:Role'))   return { records: [{ get: () => true }] }
    if (q.includes('CITypeDefinition')) return { records: [{ get: () => 12 }] }
    return { records: [] }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  findUserIdByEmail.mockResolvedValue('kc-user-esistente')
  seedSystemEnumTypes.mockResolvedValue(undefined)
  provisionTenantData.mockResolvedValue({
    rolesCreated: ['admin', 'operator'], dashboardCreated: true, notificationRulesCreated: 7,
    matricesCreated: ['incident'], workflows: [{ name: 'Incident Management', created: true }],
    gapsLeft: [{ kind: 'no_team', params: null }],
  })
  rispondiComeUnGrafoVuoto()
})

// ══════════════════════════════════════════════════════════════════════════════
describe('la password si consegna SUBITO', () => {
  it('fra impostarla e consegnarla non c\'è niente che possa fallire', async () => {
    const kc = keycloak()
    const ordine: string[] = []
    kc.setPassword = vi.fn(async () => { ordine.push('impostata') })
    await onboardTenant(kc as never, spec(), password, {
      onPassword: () => ordine.push('consegnata'),
      onStep: (l) => ordine.push(`passo: ${l.slice(0, 20)}`),
    })
    const i = ordine.indexOf('impostata')
    expect(ordine[i + 1]).toBe('consegnata')
  })

  it('e se un passo DOPO crolla, la password è già stata consegnata', async () => {
    const kc = keycloak()
    provisionTenantData.mockRejectedValue(new Error('il provisioning è caduto'))
    const consegnate: string[] = []
    await onboardTenant(kc as never, spec(), password, { onPassword: (e) => consegnate.push(e) })
      .catch(() => { /* il fallimento è il punto del test */ })
    expect(consegnate).toEqual(['admin@c-uno.it'])
  })

  it('su un utente che c\'era già la password NON si tocca, e non se ne inventa una da mostrare', async () => {
    const kc = keycloak({ post: vi.fn(async (_t: string, path: string) =>
      (path.endsWith('/users') ? { created: false } : { created: true })) })
    const consegnate: string[] = []
    const out = await onboardTenant(kc as never, spec(), password, { onPassword: (e) => consegnate.push(e) })
    expect(consegnate).toEqual([])
    expect(kc.setPassword).not.toHaveBeenCalled()
    expect(out.adminCreated).toBe(false)
    expect(out.steps.join('\n')).toContain('password left untouched')
  })
})

describe('additiva e idempotente: quello che c\'era resta com\'era', () => {
  it('realm, client e utente già presenti non si riallineano, e ogni passo lo DICE', async () => {
    const kc = keycloak({ post: vi.fn(async () => ({ created: false })) })
    // Client già completi: niente da aggiungere, quindi niente da toccare.
    kc.get = vi.fn(async () => [{ id: 'c1', redirectUris: RITORNI_COMPLETI, webOrigins: ['+'] }])
    const out = await onboardTenant(kc as never, spec(), password)
    expect(out).toMatchObject({ realmCreated: false, webClient: 'existing', portalClient: 'existing', adminCreated: false })
    const testo = out.steps.join('\n')
    expect(testo).toContain('realm "c-uno" already existed — left as it was')
    expect(testo).toContain('client "opengrafo-web" already existed')
    expect(kc.put).not.toHaveBeenCalled()
  })

  it('un tenant che c\'era già non si riscrive: la MERGE ha solo un ON CREATE', async () => {
    const kc = keycloak()
    await onboardTenant(kc as never, spec(), password)
    const merge = txRun.mock.calls.find((c) => String(c[0]).includes('MERGE (t:Tenant'))!
    const cypher = String(merge[0])
    expect(cypher).toContain('ON CREATE SET')
    expect(cypher).not.toContain('ON MATCH SET')
  })
})

describe('gli indirizzi di ritorno: l\'eccezione, e resta additiva', () => {
  it('un client preesistente con altri indirizzi rendeva il tenant IRRAGGIUNGIBILE: ora si aggiungono', async () => {
    const kc = keycloak({ post: vi.fn(async () => ({ created: false })) })
    kc.get = vi.fn(async () => [{ id: 'c1', redirectUris: ['https://vecchio.example/*'], webOrigins: ['https://vecchio.example'] }])
    const out = await onboardTenant(kc as never, spec(), password)

    expect(kc.put).toHaveBeenCalledTimes(2)   // web e portale
    const corpo = kc.put.mock.calls[0]![2] as { redirectUris: string[]; webOrigins: string[] }
    // NON si sostituisce: quello che c'era resta, e si aggiunge il mancante.
    expect(corpo.redirectUris).toContain('https://vecchio.example/*')
    expect(corpo.redirectUris).toContain('http://c-uno.localhost/*')
    expect(corpo.webOrigins).toContain('https://vecchio.example')
    expect(out.steps.join('\n')).toContain('redirect URI(s) added')
    expect(out.steps.join('\n')).toContain('would not have been reachable')
  })

  it('se sono già completi non si tocca niente, e lo dice', async () => {
    const kc = keycloak({ post: vi.fn(async () => ({ created: false })) })
    kc.get = vi.fn(async () => [{ id: 'c1', redirectUris: RITORNI_COMPLETI, webOrigins: ['+'] }])
    const out = await onboardTenant(kc as never, spec(), password)
    expect(kc.put).not.toHaveBeenCalled()
    expect(out.steps.join('\n')).toContain('redirect URIs already complete')
  })

  it('un client sparito dopo la creazione si DICE, invece di far finta', async () => {
    const kc = keycloak({ post: vi.fn(async () => ({ created: false })) })
    kc.get = vi.fn(async () => [])
    const out = await onboardTenant(kc as never, spec(), password)
    expect(out.steps.join('\n')).toContain('not found after creation — nothing to reconcile')
  })
})

describe('produzione e sviluppo non hanno gli stessi indirizzi', () => {
  it('in produzione: solo HTTPS, nessun jolly `*.localhost`, origini esplicite', async () => {
    const kc = keycloak()
    await onboardTenant(kc as never, spec({ production: true }), password)
    const creaWeb = kc.post.mock.calls.find((c) => (c[2] as { clientId?: string })?.clientId === 'opengrafo-web')!
    const corpo = creaWeb[2] as { redirectUris: string[]; webOrigins: string[] }
    expect(corpo.redirectUris).toEqual(['https://c-uno.opengrafo.it/*'])
    expect(corpo.redirectUris.some((u) => u.includes('localhost'))).toBe(false)
    expect(corpo.webOrigins).toEqual(['https://c-uno.opengrafo.it'])
    // E il realm pretende SSL da fuori.
    const creaRealm = kc.post.mock.calls[0]![2] as { sslRequired: string }
    expect(creaRealm.sslRequired).toBe('external')
  })

  it('in sviluppo: anche localhost, e le origini aperte', async () => {
    const kc = keycloak()
    await onboardTenant(kc as never, spec(), password)
    const creaWeb = kc.post.mock.calls.find((c) => (c[2] as { clientId?: string })?.clientId === 'opengrafo-web')!
    const corpo = creaWeb[2] as { redirectUris: string[]; webOrigins: string[] }
    expect(corpo.redirectUris).toContain('http://c-uno.localhost/*')
    expect(corpo.webOrigins).toEqual(['+'])
    expect((kc.post.mock.calls[0]![2] as { sslRequired: string }).sslRequired).toBe('none')
  })

  it('con un IP del Pi si aggiunge anche quell\'indirizzo, in tutte e due le modalità', async () => {
    const kc = keycloak()
    await onboardTenant(kc as never, spec({ piIp: '192-168-1-50', production: true }), password)
    const creaWeb = kc.post.mock.calls.find((c) => (c[2] as { clientId?: string })?.clientId === 'opengrafo-web')!
    expect((creaWeb[2] as { redirectUris: string[] }).redirectUris)
      .toContain('https://c-uno.192-168-1-50.nip.io/*')
  })
})

describe('il primo amministratore deve poter amministrare', () => {
  it('se il suo ruolo non gestisce persone e ruoli, l\'onboarding FALLISCE invece di consegnare un tenant inutilizzabile', async () => {
    txRun.mockImplementation(async (cypher: string) => {
      const q = String(cypher)
      if (q.includes('MATCH (r:Role')) return { records: [{ get: () => false }] }
      if (q.includes('MERGE (')) return { records: [{ get: () => true }] }
      return { records: [{ get: () => 12 }] }
    })
    const err = await onboardTenant(keycloak() as never, spec(), password).catch((e: Error) => e)
    expect((err as Error).message).toContain('does not manage people and roles')
    expect((err as Error).message).toContain(USERS_ADMIN_PERMISSION)
  })
})

describe('quello che resta a una persona si dice subito', () => {
  it('i buchi del provisioning finiscono nei passi: un tenant senza team non fa nascere una change', async () => {
    const out = await onboardTenant(keycloak() as never, spec(), password)
    expect(out.steps.join('\n')).toContain('still to configure by a person: no_team')
  })

  it('i tipi di CI spediti si VERIFICANO, e se mancano è un avviso forte', async () => {
    txRun.mockImplementation(async (cypher: string) => {
      const q = String(cypher)
      if (q.includes('CITypeDefinition')) return { records: [{ get: () => 0 }] }
      return { records: [{ get: () => true }] }
    })
    const out = await onboardTenant(keycloak() as never, spec(), password)
    const testo = out.steps.join('\n')
    expect(testo).toContain('WARNING: no CITypeDefinition')
    expect(testo).toContain('seed-metamodel.ts')
    expect(testo).toContain('the CMDB would be empty')
  })

  it('un MERGE del tenant che non restituisce righe e uno stato che non si finge di capire', async () => {
    txRun.mockImplementation(async (cypher: string) =>
      (String(cypher).includes('MERGE (t:Tenant') ? { records: [] } : { records: [{ get: () => true }] }))
    const err = await onboardTenant(keycloak() as never, spec(), password).catch((e: Error) => e)
    expect((err as Error).message).toContain('returned no rows — unexpected state')
  })
})

describe('il canale dei passi', () => {
  it('ogni passo arriva a chi guarda MENTRE succede, e anche tutti insieme alla fine', async () => {
    const visti: string[] = []
    const out = await onboardTenant(keycloak() as never, spec(), password, { onStep: (l) => visti.push(l) })
    expect(visti).toEqual(out.steps)
    expect(visti.length).toBeGreaterThan(8)
  })

  it('senza callback non si rompe niente: lo script e la console sono due chiamanti, non un obbligo', async () => {
    const out = await onboardTenant(keycloak() as never, spec(), password)
    expect(out.steps.length).toBeGreaterThan(8)
  })
})
