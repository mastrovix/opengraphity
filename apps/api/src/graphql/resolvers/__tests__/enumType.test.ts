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
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { enumTypeResolvers, customizeEnumType } = await import('../enumType.js')
const { getSession } = await import('@opengraphity/neo4j')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, role: 'operator' }
const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

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

  it('enumTypes: WHERE (e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = \'system\')), scope opzionale include "shared"', async () => {
    const s = fakeSession([{ records: [rec(ENUM_ROW), rec({ ...ENUM_ROW, id: 'e-sys', tenantId: 'system', isSystem: true, values: '["a","b"]' })] }])

    const out = await enumTypeResolvers.Query.enumTypes(null, { scope: 'itil' }, operator)

    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain("(e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system'))")
    expect(cypher).toContain('(e.scope = $scope OR e.scope = "shared")')
    expect(params).toEqual({ tenantId: 'tenant-1', scope: 'itil' })
    // values sia come lista nativa sia come JSON serializzato
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

  it('nome già usato nel tenant → ValidationError, nessuna CREATE', async () => {
    const s = fakeSession([{ records: [rec({ id: 'e-dup' })] }])
    await expectCode(enumTypeResolvers.Mutation.createEnumType(null, { input: { name: 'ticket_source', label: 'X', values: ['a'], scope: 'itil' } }, admin), 'BAD_USER_INPUT', /already exists for this tenant/)
    expect(s.txRun.mock.calls[0]![0]).toContain('MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})')
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('valido → CREATE con tenant_id = $tenantId (mai "system") e is_system: false', async () => {
    const s = fakeSession([{ records: [] }])
    const out = await enumTypeResolvers.Mutation.createEnumType(null, { input: { name: 'ticket_source', label: 'Origine', values: ['portal'], scope: 'cmdb' } }, admin)
    const [cypher, params] = s.txRun.mock.calls[1]!
    expect(cypher).toContain('CREATE (e:EnumTypeDefinition {')
    expect(cypher).toContain('tenant_id:  $tenantId')
    expect(cypher).toContain('is_system:  false')
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
    const s = fakeSession([{ records: [rec({ isSystem: false, tenantId: 'tenant-1', name: 'ticket_source' })] }, { records: [rec({ ...ENUM_ROW, label: 'Nuova' })] }])
    const out = await enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-1', input: { label: 'Nuova' } }, admin)
    const [cypher, params] = s.txRun.mock.calls[1]!
    expect(cypher).toContain('SET e.label      = coalesce($label, e.label)')
    expect(params).toEqual({ id: 'e-1', tenantId: 'tenant-1', label: 'Nuova', values: null, scope: null, now: expect.any(String) })
    expect(out.label).toBe('Nuova')
  })

  it('la mutation scrive SOLO con tenant_id = $tenantId (mai "system")', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: true, tenantId: 'tenant-1', name: 'severity' })] }, { records: [rec({ ...ENUM_ROW })] }])
    await enumTypeResolvers.Mutation.updateEnumType(null, { id: 'e-own', input: { values: ['x'] } }, admin)
    expect(s.txRun.mock.calls[1]![0]).not.toContain("'system'")
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
    expect(cypher).not.toContain("'system'")
    expect(params).toEqual({ id: 'e-sys', tenantId: 'tenant-1' })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('enum del tenant marcato is_system → ValidationError, nessuna DELETE', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: true, usageCount: { toNumber: () => 0 } })] }])
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin), 'BAD_USER_INPUT', /System enum types cannot be deleted/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('enum in uso da campi → ValidationError con conteggio', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: false, usageCount: { toNumber: () => 2 } })] }])
    await expectCode(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin), 'BAD_USER_INPUT', /Enum in use by 2 fields/)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('enum libero del tenant → DETACH DELETE scoped per tenant', async () => {
    const s = fakeSession([{ records: [rec({ isSystem: false, usageCount: { toNumber: () => 0 } })] }])
    await expect(enumTypeResolvers.Mutation.deleteEnumType(null, { id: 'e-1' }, admin)).resolves.toBe(true)
    const [cypher, params] = s.txRun.mock.calls[1]!
    expect(cypher).toContain('MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId}) DETACH DELETE e')
    expect(params).toEqual({ id: 'e-1', tenantId: 'tenant-1' })
  })
})
