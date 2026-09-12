/**
 * enumType.ts — pin della Cypher: le letture vedono il proprio tenant più il
 * SOLO tenant condiviso `system`
 * (`e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')`
 * — personalizzazioni ondata 0, B0-2: prima era `OR e.is_system = true`, cioè
 * il flag di protezione usato come flag di visibilità, che mostrava a ogni
 * tenant i vocabolari di tutti gli altri); le scritture: create con tenant_id
 * del contesto e is_system=false; update e delete solo su
 * `{tenant_id: $tenantId}`; non-admin → Forbidden prima della sessione.
 *
 * Ondata 1 (A1-1): `isShipped` dice di chi è il vocabolario (`tenant_id =
 * 'system'`), cosa che `is_system` — flag di protezione scritto anche sulle
 * copie per tenant — non dice; `customizeEnumType` è la copia su scrittura, e
 * `updateEnumType` su un nodo spedito non finisce più in un NotFound opaco ma
 * rimanda a «Personalizza».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { int as neo4jInt } from 'neo4j-driver'
import type { GraphQLContext } from '../../../context.js'

/**
 * `toNumber` è quello VERO (non un finto): `deleteEnumType` converte il
 * `count(...)` con lui, e il difetto che questo test non vedeva era proprio
 * una conversione fatta a mano (`.toNumber()` su un valore che può essere un
 * `number` normale). Mockarlo nasconderebbe di nuovo il problema.
 */
vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { getSession: vi.fn(), toNumber: orig.toNumber }
})
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { enumTypeResolvers, customizeEnumType } = await import('../enumType.js')
const { getSession } = await import('@opengraphity/neo4j')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, role: 'operator' }
/** `keys` serve a lib/enumValueUsage.ts, che legge le righe per chiave (B7-2). */
const rec = (map: Record<string, unknown>) => ({ keys: Object.keys(map), get: (k: string) => (k in map ? map[k] : null) })
/** Un `count(...)` come lo dà il driver quando i numeri sono «lossless». */
const int = (n: number) => neo4jInt(n)

const ENUM_ROW = { id: 'e-1', tenantId: 'tenant-1', name: 'ticket_source', label: 'Origine', values: ['portal', 'email'], isSystem: false, scope: 'itil', createdAt: 'c', updatedAt: 'u' }

function fakeSession(responses: Array<{ records: unknown[] }>) {
  const queue = [...responses]
  const txRun = vi.fn().mockImplementation(async () => queue.shift() ?? { records: [] })
  const tx = { run: txRun }
  const s = {
    txRun,
    executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

describe('letture — tenant + sistema', () => {
  beforeEach(() => vi.clearAllMocks())

  /**
   * RINEGOZIATO (ondata 8 · A-18): questo test pinnava la TOLLERANZA di
   * `mapEnum` verso le due forme di `values` (lista o stringa JSON). La
   * stringa era scritta da un posto solo — `seed-metamodel.ts` per `ci_chain` —
   * e quel `JSON.parse` di ripiego nascondeva l'incoerenza a tutti: al primo
   * consumatore che facesse `values.length` sarebbe stato un difetto. Ora il
   * seed scrive una lista, la migrazione 20260918_1910 normalizza il nodo
   * esistente, e una stringa è un dato rotto da dire, non da indovinare.
   */
  it('values come stringa JSON → errore che nomina il nodo e la migrazione, invece di un JSON.parse silenzioso', async () => {
    fakeSession([{ records: [rec({ ...ENUM_ROW, tenantId: 'system', name: 'ci_chain', values: '["Application","Infrastructure"]' })] }])
    await expect(enumTypeResolvers.Query.enumTypes(null, {}, operator))
      .rejects.toThrow(/system\/ci_chain: "values" non è una lista di stringhe.*20260918_1910/s)
  })

  it('enumTypes: WHERE (e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = \'system\')), scope opzionale include "shared"', async () => {
    const s = fakeSession([{ records: [rec(ENUM_ROW), rec({ ...ENUM_ROW, id: 'e-sys', tenantId: 'system', isSystem: true, values: ['a', 'b'] })] }])

    const out = await enumTypeResolvers.Query.enumTypes(null, { scope: 'itil' }, operator)

    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain("(e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system'))")
    expect(cypher).toContain('(e.scope = $scope OR e.scope = "shared")')
    expect(params).toEqual({ tenantId: 'tenant-1', scope: 'itil' })
    expect(out.map((e) => e.values)).toEqual([['portal', 'email'], ['a', 'b']])
    expect(s.close).toHaveBeenCalledOnce()
  })

  // A1-1: `is_system` è un flag di PROTEZIONE scritto anche sulle copie per
  // tenant, quindi non dice di chi è il vocabolario. `isShipped` sì: lo legge
  // dal tenant, ed è quello che l'interfaccia usa per offrire «Personalizza».
  it('isShipped viene dal tenant, non da is_system', async () => {
    fakeSession([{ records: [
      rec({ ...ENUM_ROW, isSystem: true }),                               // copia per tenant, protetta ma NON spedita
      rec({ ...ENUM_ROW, id: 'e-sys', tenantId: 'system', isSystem: true }),
    ] }])
    const out = await enumTypeResolvers.Query.enumTypes(null, {}, operator)
    expect(out.map((e) => [e.tenantId, e.isSystem, e.isShipped])).toEqual([
      ['tenant-1', true, false],
      ['system',   true, true],
    ])
  })

  it('enumType(id): stesso predicato; id di altro tenant non-system → null', async () => {
    const s = fakeSession([{ records: [] }])
    await expect(enumTypeResolvers.Query.enumType(null, { id: 'e-altrui' }, operator)).resolves.toBeNull()
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain("WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')")
    expect(params).toEqual({ id: 'e-altrui', tenantId: 'tenant-1' })
  })

  // B0-2 (A-3/D-5): `is_system` è scritto sugli enum seminati in OGNI tenant,
  // quindi `OR e.is_system = true` faceva passare i vocabolari degli altri
  // clienti. Il predicato deve nominare il tenant condiviso `system`: nessuna
  // lettura può più tornare un enum `is_system` di un tenant diverso.
  it('isolamento: il predicato non ammette enum is_system di un ALTRO tenant (né in enumTypes né in enumType)', async () => {
    const seen: string[] = []
    const s1 = fakeSession([{ records: [] }])
    await enumTypeResolvers.Query.enumTypes(null, {}, operator)
    seen.push(s1.txRun.mock.calls[0]![0] as string)
    vi.clearAllMocks()
    const s2 = fakeSession([{ records: [] }])
    await enumTypeResolvers.Query.enumType(null, { id: 'e-x' }, operator)
    seen.push(s2.txRun.mock.calls[0]![0] as string)

    for (const cypher of seen) {
      // niente `is_system` senza il vincolo sul tenant condiviso
      expect(cypher).not.toMatch(/e\.is_system = true(?! AND e\.tenant_id = 'system')/)
      expect(cypher).toContain("e.is_system = true AND e.tenant_id = 'system'")
    }
  })
})

describe('createEnumType', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non admin → Forbidden prima di aprire la sessione', async () => {
    await expectCode(enumTypeResolvers.Mutation.createEnumType(null, { input: { name: 'x', label: 'X', values: ['a'], scope: 'itil' } }, operator), 'FORBIDDEN')
    expect(getSession).not.toHaveBeenCalled()
  })

  it.each([
    [{ name: 'NotSnake', label: 'X', values: ['a'], scope: 'itil' }, /snake_case/],
    [{ name: 'ok_name', label: 'X', values: [], scope: 'itil' }, /at least one entry/],
    [{ name: 'ok_name', label: 'X', values: ['a'], scope: 'global' }, /scope must be one of: itil, cmdb, shared/],
  ])('input non valido %j → ValidationError senza sessione', async (input, pattern) => {
    await expectCode(enumTypeResolvers.Mutation.createEnumType(null, { input }, admin), 'BAD_USER_INPUT', pattern)
    expect(getSession).not.toHaveBeenCalled()
  })

  /**
   * D-17 (ondata 8): la creazione era «leggi, poi crea» in DUE transazioni, e
   * i due test che stavano qui pinnavano proprio quella forma (una MATCH di
   * controllo, poi una CREATE). Ora è UNA scrittura idempotente: MERGE sulla
   * chiave naturale (tenant_id, name), e chi arriva secondo lo capisce
   * dall'`id` che torna diverso dal suo. I due test sono riscritti sulla forma
   * nuova — la promessa verso il chiamante (stesso messaggio, stesso codice) è
   * identica.
   */
  function mergeSession(returnedId: 'echo' | string) {
    const txRun = vi.fn().mockImplementation(async (_c: string, p: Record<string, unknown>) => ({
      records: [rec({ id: returnedId === 'echo' ? p['id'] : returnedId })],
    }))
    const tx = { run: txRun }
    const s = {
      txRun,
      executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
      executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
      close: vi.fn().mockResolvedValue(undefined),
    }
    vi.mocked(getSession).mockReturnValue(s as never)
    return s
  }

  it('nome già usato nel tenant → ValidationError; una sola scrittura, nessuna lettura di controllo', async () => {
    const s = mergeSession('e-dup')
    await expectCode(enumTypeResolvers.Mutation.createEnumType(null, { input: { name: 'ticket_source', label: 'X', values: ['a'], scope: 'itil' } }, admin), 'BAD_USER_INPUT', /already exists for this tenant/)
    expect(s.executeRead).not.toHaveBeenCalled()
    expect(s.txRun).toHaveBeenCalledTimes(1)
  })

  it('corsa persa contro il vincolo → lo stesso rifiuto, non un errore interno', async () => {
    const txRun = vi.fn().mockRejectedValue(new Error('Node(7) already exists with label `EnumTypeDefinition` and properties'))
    const tx = { run: txRun }
    vi.mocked(getSession).mockReturnValue({
      executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
      executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
      close: vi.fn().mockResolvedValue(undefined),
    } as never)
    await expectCode(enumTypeResolvers.Mutation.createEnumType(null, { input: { name: 'ticket_source', label: 'X', values: ['a'], scope: 'itil' } }, admin), 'BAD_USER_INPUT', /already exists for this tenant/)
  })

  it('valido → MERGE sulla chiave naturale, tenant_id = $tenantId (mai "system") e is_system = false', async () => {
    const s = mergeSession('echo')
    const out = await enumTypeResolvers.Mutation.createEnumType(null, { input: { name: 'ticket_source', label: 'Origine', values: ['portal'], scope: 'cmdb' } }, admin)
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MERGE (e:EnumTypeDefinition {tenant_id: $tenantId, name: $name})')
    expect(cypher).toContain('ON CREATE SET')
    expect(cypher).toContain('e.is_system  = false')
    expect(cypher).not.toContain("'system'")
    expect(params).toMatchObject({ tenantId: 'tenant-1', name: 'ticket_source', values: ['portal'], scope: 'cmdb' })
    expect(out).toMatchObject({ tenantId: 'tenant-1', isSystem: false, name: 'ticket_source' })
  })
})

describe('updateEnumType', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non admin → Forbidden senza sessione', async () => {
    await expectCode(enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { label: 'X' } }, operator), 'FORBIDDEN')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('id di altro tenant (non system) → NotFound, nessuna scrittura', async () => {
    const s = fakeSession([{ records: [] }])
    await expectCode(enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-altrui', input: { label: 'X' } }, admin), 'NOT_FOUND')
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('copia del tenant marcata is_system + cambio scope → ValidationError, nessuna scrittura', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: true, tenantId: 'tenant-1', name: 'severity' })] }])
    await expectCode(enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-sys', input: { scope: 'cmdb' } }, admin), 'BAD_USER_INPUT', /Cannot change scope of system enum types/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  // A1-1: prima la scrittura su `{id, tenant_id: $tenantId}` non trovava il
  // nodo spedito e usciva con un NotFound opaco. Adesso l'errore indica
  // `customizeEnumType`.
  it('vocabolario SPEDITO → errore che rimanda a «Personalizza», nessuna scrittura', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: true, tenantId: 'system', name: 'severity' })] }])
    await expectCode(enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-sys', input: { values: ['x'] } }, admin), 'BAD_USER_INPUT', /spedito col prodotto.*customizeEnumType/s)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('enum del tenant → SET con label/values coalesce, tenantId del contesto nei parametri', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: false, tenantId: 'tenant-1', name: 'ticket_source', values: ['portal', 'email'] })] }, { records: [rec({ ...ENUM_ROW, label: 'Nuova' })] }])
    const out = await enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { label: 'Nuova' } }, admin)
    const [cypher, params] = s.txRun.mock.calls[1]!
    expect(cypher).toContain('SET e.label      = coalesce($label, e.label)')
    expect(params).toEqual({ id: 'e-1', tenantId: 'tenant-1', label: 'Nuova', values: null, scope: null, now: expect.any(String) })
    expect(out.label).toBe('Nuova')
  })

  it('la mutation scrive SOLO con tenant_id = $tenantId (mai "system")', async () => {
    const s = fakeSession([
      { records: [rec({ isSystem: true, tenantId: 'tenant-1', name: 'severity', values: ['x'] })] },
      { records: [rec({ ...ENUM_ROW })] },
    ])
    await enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-own', input: { values: ['x'] } }, admin)
    expect(s.txRun.mock.calls[1]![0]).not.toContain("'system'")
  })
})

/**
 * Ondata 7 · B7-2 / A-13 — togliere un valore ancora in uso.
 *
 * Prima `values` veniva sostituito in blocco: nessun conteggio, e i record
 * restavano con un valore che il vocabolario non aveva più (dal vivo 68 CI su
 * c-one). Ora si conta e si rifiuta; per procedere serve una sostituzione
 * esplicita, applicata nella STESSA transazione.
 */
describe('updateEnumType — valore in uso (B7-2)', () => {
  beforeEach(() => vi.clearAllMocks())

  const OWN = (values: string[]) => rec({ isSystem: false, tenantId: 'tenant-1', name: 'ci_status', values })
  /** Le righe che `enumValueBindings` e il conteggio si aspettano. */
  const BINDING = { records: [rec({ label: 'ConfigurationItem', typeName: '__base__', fieldName: 'status' })] }
  const COUNT   = (value: string, n: number) => ({ records: [rec({ value, n })] })
  const POLICY  = (raw: string | null) => ({ records: [rec({ raw })] })

  it('valore rimosso e ancora su dei record → rifiutato, con il conteggio e la via d\'uscita; nessuna scrittura', async () => {
    const s = fakeSession([
      { records: [OWN(['active', 'decommissioned'])] },
      BINDING,
      COUNT('decommissioned', 12),
      POLICY(null),
    ])
    await expectCode(
      enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { values: ['active'] } }, admin),
      'BAD_USER_INPUT',
      /"decommissioned" è ancora usato da 12 __base__\.status.*replacements/s,
    )
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('valore rimosso e citato dalla SEMANTICA del ciclo di vita → rifiutato (è ciò che rende sicura la scelta delle due liste sulla policy)', async () => {
    fakeSession([
      { records: [OWN(['active', 'decommissioned'])] },
      BINDING,
      COUNT('decommissioned', 0),
      POLICY(JSON.stringify({ retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'], ignore_lifecycle_statuses: [] })),
    ])
    await expectCode(
      enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { values: ['active'] } }, admin),
      'BAD_USER_INPUT',
      /la policy degli allarmi \(retired_statuses\)/,
    )
  })

  it('valore rimosso e non usato da nessuno → passa', async () => {
    const s = fakeSession([
      { records: [OWN(['active', 'obsoleto'])] },
      BINDING,
      { records: [] },
      POLICY(null),
      { records: [rec({ ...ENUM_ROW, name: 'ci_status', values: ['active'] })] },
    ])
    const out = await enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { values: ['active'] } }, admin)
    expect(out.values).toEqual(['active'])
    expect(s.executeWrite).toHaveBeenCalled()
  })

  it('sostituzione: `to` deve stare fra i valori nuovi e `from` fra quelli rimossi', async () => {
    fakeSession([{ records: [OWN(['active', 'decommissioned'])] }])
    await expectCode(
      enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { values: ['active'], replacements: [{ from: 'decommissioned', to: 'dismesso' }] } }, admin),
      'BAD_USER_INPUT',
      /il valore di sostituzione "dismesso" non è fra i valori nuovi/,
    )
    fakeSession([{ records: [OWN(['active', 'decommissioned'])] }])
    await expectCode(
      enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { values: ['active', 'decommissioned'], replacements: [{ from: 'active', to: 'decommissioned' }] } }, admin),
      'BAD_USER_INPUT',
      /"active" non è fra i valori che stai togliendo/,
    )
  })

  it('sostituzione valida → non conta gli usi, riscrive i record e poi il vocabolario, nella stessa transazione', async () => {
    const s = fakeSession([
      { records: [OWN(['active', 'decommissioned'])] },
      BINDING,                                                   // enumValueBindings, dentro la transazione
      { records: [rec({ n: 7 })] },                              // SET sui 7 CI
      POLICY(null),                                              // niente policy da riscrivere
      { records: [rec({ ...ENUM_ROW, name: 'ci_status', values: ['active', 'dismesso'] })] },
    ])
    const out = await enumTypeResolvers.Mutation.updateEnumType(
      null,
      { id: 'e-1', input: { values: ['active', 'dismesso'], replacements: [{ from: 'decommissioned', to: 'dismesso' }] } },
      admin,
    )
    expect(out.values).toEqual(['active', 'dismesso'])
    const setCall = s.txRun.mock.calls.find((c) => String(c[0]).includes('SET n.status = $to'))
    expect(setCall).toBeDefined()
    expect(setCall![1]).toMatchObject({ tenantId: 'tenant-1', from: 'decommissioned', to: 'dismesso' })
    // il vocabolario si scrive DOPO i record
    const enumWriteIdx = s.txRun.mock.calls.findIndex((c) => String(c[0]).includes('SET e.label'))
    expect(enumWriteIdx).toBeGreaterThan(s.txRun.mock.calls.indexOf(setCall!))
  })
})

/**
 * A1-1 — copia su scrittura: un vocabolario spedito non si modifica in posto,
 * si personalizza. La copia ha lo stesso NOME (è il nome che la fa vincere in
 * lettura, vedi lib/enumScope.ts) e is_system = false.
 */
describe('customizeEnumType', () => {
  beforeEach(() => vi.clearAllMocks())

  const SHIPPED = { tenantId: 'system', name: 'severity', label: 'Severity', values: ['low', 'high'], scope: 'shared' }

  it('non admin → Forbidden senza sessione', async () => {
    await expectCode(customizeEnumType(null, { id: 'e-sys' }, operator), 'FORBIDDEN')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('id sconosciuto o di un altro cliente → NotFound, nessuna scrittura', async () => {
    const s = fakeSession([{ records: [] }])
    await expectCode(customizeEnumType(null, { id: 'e-altrui' }, admin), 'NOT_FOUND')
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('WHERE e.tenant_id IN [$tenantId, $systemTenant]')
    expect(params).toEqual({ id: 'e-altrui', tenantId: 'tenant-1', systemTenant: 'system' })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('vocabolario già del tenant → errore che lo dice, nessuna copia', async () => {
    const s = fakeSession([{ records: [rec({ ...SHIPPED, tenantId: 'tenant-1' })] }])
    await expectCode(customizeEnumType(null, { id: 'e-1' }, admin), 'BAD_USER_INPUT', /è già tuo/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('il tenant ha già un vocabolario con quel nome → errore che lo nomina, nessuna copia', async () => {
    const s = fakeSession([
      { records: [rec(SHIPPED)] },
      { records: [rec({ id: 'own-9' })] },
    ])
    await expectCode(customizeEnumType(null, { id: 'e-sys' }, admin), 'BAD_USER_INPUT', /Hai già un vocabolario "severity" \(own-9\)/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('spedito e senza copia → CREATE con lo stesso nome e valori, tenant del contesto, is_system false', async () => {
    const s = fakeSession([
      { records: [rec(SHIPPED)] },
      { records: [] },
      { records: [rec({ ...ENUM_ROW, id: 'new-1', name: 'severity', label: 'Severity', values: ['low', 'high'], scope: 'shared' })] },
    ])
    const out = await customizeEnumType(null, { id: 'e-sys' }, admin)
    const [cypher, params] = s.txRun.mock.calls[2]!
    expect(cypher).toContain('CREATE (e:EnumTypeDefinition {')
    expect(cypher).toContain('is_system:  false')
    expect(params).toMatchObject({ tenantId: 'tenant-1', name: 'severity', values: ['low', 'high'], scope: 'shared' })
    expect(out).toMatchObject({ id: 'new-1', name: 'severity', tenantId: 'tenant-1', isShipped: false })
  })

  it('values serializzati come JSON sul nodo spedito → copiati come lista', async () => {
    const s = fakeSession([
      { records: [rec({ ...SHIPPED, values: '["low","high"]' })] },
      { records: [] },
      { records: [rec({ ...ENUM_ROW, name: 'severity', values: ['low', 'high'] })] },
    ])
    await customizeEnumType(null, { id: 'e-sys' }, admin)
    expect(s.txRun.mock.calls[2]![1]!['values']).toEqual(['low', 'high'])
  })

  it('è esposta fra le Mutation', () => {
    expect(enumTypeResolvers.Mutation.customizeEnumType).toBe(customizeEnumType)
  })
})

describe('deleteEnumType', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non admin → Forbidden senza sessione', async () => {
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, operator), 'FORBIDDEN')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('il check è SOLO {id, tenant_id: $tenantId}: un enum "system" o di altro tenant → NotFound, nessuna DELETE', async () => {
    const s = fakeSession([{ records: [] }])
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-sys' }, admin), 'NOT_FOUND')
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})')
    // Il vocabolario da cancellare si cerca SOLO nel tenant; `'system'` compare
    // adesso in una sola riga, quella che legge il vocabolario SPEDITO con lo
    // stesso nome (ondata 7 · B7-2: cancellare la copia del cliente lo rimette
    // in gioco, e non deve far sparire in silenzio i valori suoi ancora in uso).
    expect(cypher).toContain("OPTIONAL MATCH (shipped:EnumTypeDefinition {name: e.name, tenant_id: 'system'})")
    expect(cypher.match(/'system'/g)).toHaveLength(1)
    expect(params).toEqual({ id: 'e-sys', tenantId: 'tenant-1' })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('enum del tenant marcato is_system → ValidationError, nessuna DELETE', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: true, usageCount: 0 })] }])
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin), 'BAD_USER_INPUT', /System enum types cannot be deleted/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('enum in uso da campi → ValidationError con conteggio', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: false, usageCount: int(2) })] }])
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin), 'BAD_USER_INPUT', /Enum in use by 2 fields/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  /**
   * Il percorso RIUSCITO, nelle DUE forme in cui `count(...)` può arrivare.
   * Prima il conteggio veniva convertito a mano con `.toNumber()`: con un
   * `number` normale la cancellazione moriva con «get(...).toNumber is not a
   * function» su QUALUNQUE vocabolario, anche uno non usato da nessuno — e i
   * test non se ne accorgevano perché fabbricavano solo la forma `Integer`.
   */
  it.each([['number semplice', 0 as unknown], ['Integer del driver', int(0) as unknown]])(
    'enum libero del tenant (%s) → DETACH DELETE scoped per tenant',
    async (_shape, usageCount) => {
      const s = fakeSession([{ records: [rec({ isSystem: false, usageCount, name: 'ticket_source', values: ['portal'], shippedValues: ['portal'] })] }])
      await expect(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin)).resolves.toBe(true)
      const [cypher, params] = s.txRun.mock.calls[1]!
      expect(cypher).toContain('MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId}) DETACH DELETE e')
      expect(params).toEqual({ id: 'e-1', tenantId: 'tenant-1' })
    },
  )

  /**
   * Ondata 7 · B7-2. `usageCount` conta solo i campi agganciati a QUESTO nodo,
   * e dal vivo i campi condivisi sono agganciati ai nodi di un altro cliente
   * (C-6): cancellare la copia del cliente tornava quindi a quello spedito
   * **in silenzio**, facendo sparire dai menu i valori che il cliente aveva
   * aggiunto e lasciando i record su valori che nessun vocabolario ha più —
   * lo stesso difetto A-13, da un'altra porta.
   */
  it('la copia del tenant con valori SUOI ancora in uso → rifiutata, dicendo quali valori e dove', async () => {
    const s = fakeSession([
      { records: [rec({ isSystem: false, usageCount: 0, name: 'ci_status', values: ['active', 'dismesso'], shippedValues: ['active'] })] },
      { records: [rec({ label: 'ConfigurationItem', typeName: '__base__', fieldName: 'status' })] },   // enumValueBindings
      { records: [rec({ value: 'dismesso', n: int(7) })] },                                            // conteggio
      { records: [rec({ raw: null })] },                                                               // policy
    ])
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin), 'BAD_USER_INPUT',
      /riporterebbe a quello spedito col prodotto \(active\).*"dismesso" \(7 __base__\.status\)/s)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('la copia del tenant i cui valori extra NON sono in uso → si cancella (annullare la personalizzazione resta possibile)', async () => {
    const s = fakeSession([
      { records: [rec({ isSystem: false, usageCount: 0, name: 'ci_status', values: ['active', 'dismesso'], shippedValues: ['active'] })] },
      { records: [rec({ label: 'ConfigurationItem', typeName: '__base__', fieldName: 'status' })] },
      { records: [] },                                                                                 // nessun record con `dismesso`
      { records: [rec({ raw: null })] },
      { records: [] },                                                                                 // la DELETE
    ])
    await expect(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin)).resolves.toBe(true)
    expect(s.executeWrite).toHaveBeenCalled()
  })
})
