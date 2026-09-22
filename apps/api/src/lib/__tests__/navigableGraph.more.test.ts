/**
 * The report builder's entity catalogue (`navigableGraph`): the CI side that
 * comes from the tenant's metamodel, and `getNavigableRelations`.
 *
 * Why these behaviours matter to a user building a report:
 *  - CI types come from the metamodel of THIS tenant (base + its own), with
 *    their fields, vocabularies and relations; a CI type must always offer a
 *    "name" column, or a table of CIs cannot say which CI a row is.
 *  - Enum values stored as JSON text must be parsed; a CORRUPT value must fail
 *    loudly with a readable message (C-28), not surface a bare SyntaxError or
 *    silently offer no values.
 *  - Ticket and task entities have fixed relations: asking for them must not
 *    hit the graph. CI relations are read from the metamodel, tenant-scoped.
 *  - Library fields are added to service requests only once, and a field the
 *    metamodel already declares wins over the library copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = { close: vi.fn().mockResolvedValue(undefined), executeRead: vi.fn() }
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session) }))
vi.mock('@opengraphity/schema-generator', () => ({
  toPascalCase: (s: string) => s.replace(/(^|_)(\w)/g, (_m, _u, c: string) => c.toUpperCase()),
}))
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => log) }
vi.mock('../logger.js', () => ({ logger: log }))
vi.mock('../enumScope.js', () => ({
  enumScopeClause: () => '',
  loadTenantEnumOverrides: vi.fn().mockResolvedValue(new Map()),
  applyEnumOverrides: <T>(rows: T[]) => rows,
}))
vi.mock('../workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(async () => [{ name: 'new', stepOrder: 1 }]) }))
const itil = vi.hoisted(() => ({ types: [] as Array<Record<string, unknown>> }))
vi.mock('../itilTypes.js', () => ({ loadITILTypes: vi.fn(async () => itil.types) }))
const formFields = vi.fn(async () => [] as Array<Record<string, unknown>>)
vi.mock('../catalogForm.js', () => ({ formFields: () => formFields() }))

const { getNavigableEntities, getNavigableRelations } = await import('../navigableGraph.js')
const { getSession } = await import('@opengraphity/neo4j')

const node = (properties: Record<string, unknown>) => ({ properties })
const record = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] })

beforeEach(() => {
  vi.clearAllMocks()
  itil.types = []
  formFields.mockResolvedValue([])
})

type Entity = Awaited<ReturnType<typeof getNavigableEntities>>[number]
const byType = (list: Entity[], t: string) => list.find((e) => e.entityType === t)!

describe('getNavigableEntities — CI types from the metamodel', () => {
  it('maps fields, vocabularies, relations and system relations of each CI type', async () => {
    session.executeRead.mockResolvedValue({
      records: [record({
        t: node({ name: 'server', label: 'Server', neo4j_label: null }),
        fields: [
          { f: node({ name: 'os', label: 'OS', field_type: 'enum', enum_values: null }), enumId: 'e1', enumName: 'os_family', enumValues: ['linux', 'windows'] },
          { f: node({ name: 'env', label: 'Env', field_type: 'enum', enum_values: '["prod","test"]' }), enumId: null, enumName: null, enumValues: null },
          { f: node({ name: 'notes', label: 'Notes', field_type: 'string', enum_values: '' }), enumId: null, enumName: null, enumValues: null },
          { f: node({ name: 'rack', label: 'Rack', field_type: 'enum', enum_values: null }), enumId: 'e2', enumName: 'racks', enumValues: '["r1"]' },
          // An OPTIONAL MATCH with no field yields a null row: it must be dropped.
          { f: null, enumId: null, enumName: null, enumValues: null },
        ],
        relations: [node({ relationship_type: 'RUNS_ON', direction: 'outgoing', label: 'Runs on', target_type: 'virtual_machine' }), null],
        systemRelations: [node({ relationship_type: 'OWNED_BY', label: 'Owner', target_entity: 'Team' }), null],
      })],
    })
    const server = byType(await getNavigableEntities('t1'), 'server')
    expect(server.group).toBe('cmdb')
    // Without a stored Neo4j label, the label is derived from the type name.
    expect(server.neo4jLabel).toBe('Server')
    // The product's "name" column is prepended because the type does not declare it.
    expect(server.fields.map((f) => f.name)).toEqual(['name', 'os', 'env', 'notes', 'rack'])
    expect(server.fields.find((f) => f.name === 'os')).toMatchObject({ enumValues: ['linux', 'windows'], enumTypeName: 'os_family' })
    expect(server.fields.find((f) => f.name === 'env')).toMatchObject({ enumValues: ['prod', 'test'], enumTypeName: null })
    expect(server.fields.find((f) => f.name === 'notes')!.enumValues).toEqual([])
    expect(server.fields.find((f) => f.name === 'rack')!.enumValues).toEqual(['r1'])
    expect(server.relations).toEqual([
      { relationshipType: 'RUNS_ON', direction: 'outgoing', label: 'Runs on', targetEntityType: 'virtual_machine', targetLabel: 'VirtualMachine', targetNeo4jLabel: 'VirtualMachine' },
      { relationshipType: 'OWNED_BY', direction: 'outgoing', label: 'Owner', targetEntityType: 'Team', targetLabel: 'Team', targetNeo4jLabel: 'Team' },
    ])
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('a CI type that declares its own "name" keeps it, with its own label; a stored Neo4j label wins', async () => {
    session.executeRead.mockResolvedValue({
      records: [record({
        t: node({ name: 'database', label: 'Database', neo4j_label: 'DatabaseInstance' }),
        fields: [{ f: node({ name: 'name', label: 'DB name', field_type: 'string' }), enumId: null, enumName: null, enumValues: null }],
        relations: [],
        systemRelations: [],
      })],
    })
    const db = byType(await getNavigableEntities('t1'), 'database')
    expect(db.neo4jLabel).toBe('DatabaseInstance')
    expect(db.fields).toEqual([{ name: 'name', label: 'DB name', fieldType: 'string', enumValues: [], enumTypeName: null }])
  })

  it.each([
    ['{not json', /enum values are not valid JSON/],
    ['{"a":1}', /enum values are not a JSON array/],
  ])('corrupt enum values (%s) fail loudly with a readable message, and the session is closed', async (raw, msg) => {
    session.executeRead.mockResolvedValue({
      records: [record({
        t: node({ name: 'server', label: 'Server' }),
        fields: [{ f: node({ name: 'env', label: 'Env', field_type: 'enum', enum_values: raw }), enumId: null, enumName: null, enumValues: null }],
        relations: [],
        systemRelations: [],
      })],
    })
    await expect(getNavigableEntities('t1')).rejects.toThrow(msg)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('the metamodel query is scoped to the tenant', async () => {
    session.executeRead.mockImplementation(async (work: (tx: { run: (q: string, p: unknown) => unknown }) => unknown) =>
      work({ run: (_q, p) => { expect(p).toEqual({ tenantId: 't-scope' }); return { records: [] } } }))
    await getNavigableEntities('t-scope')
    expect(session.executeRead).toHaveBeenCalled()
  })
})

describe('getNavigableEntities — tickets without a stored label, and the form library', () => {
  it('a ticket type without neo4jLabel gets one from its name; library fields are added once and never over a metamodel field', async () => {
    session.executeRead.mockResolvedValue({ records: [] })
    itil.types = [{
      name: 'service_request', label: 'Request', neo4jLabel: null,
      fields: [
        { name: 'number', label: 'No.', fieldType: 'string', enumValues: [], enumTypeName: null },
        { name: 'env', label: 'Env', fieldType: 'enum', enumValues: ['prod'], enumTypeName: 'environment' },
      ],
    }]
    formFields.mockResolvedValue([
      { name: 'env', label: 'ENV (library)', fieldType: 'enum', vocabulary: 'other' },
      { name: 'budget', label: 'Budget', fieldType: 'number', vocabulary: null },
    ])
    const sr = byType(await getNavigableEntities('t1'), 'ServiceRequest')
    // "number" is declared by the metamodel here, so the product one is not added twice.
    expect(sr.fields.map((f) => f.name)).toEqual(['number', 'env', 'budget'])
    expect(sr.fields.find((f) => f.name === 'number')!.label).toBe('No.')
    expect(sr.fields.find((f) => f.name === 'env')!.enumTypeName).toBe('environment')
    expect(sr.fields.find((f) => f.name === 'budget')).toEqual({ name: 'budget', label: 'Budget', fieldType: 'number', enumValues: [], enumTypeName: null })
  })
})

describe('getNavigableRelations', () => {
  it('fixed entities answer from the built-in list without opening a session', async () => {
    const rels = await getNavigableRelations('Change', 'Change', 't1')
    expect(rels.map((r) => r.relationshipType)).toEqual(expect.arrayContaining(['AFFECTS_CI', 'HAS_ASSESSMENT', 'HAS_TASK']))
    // The internal source marker must not leak into the API shape.
    expect(rels.every((r) => !('sourceEntityType' in r))).toBe(true)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('CI types read relations and system relations from the metamodel, tenant-scoped', async () => {
    let params: unknown
    session.executeRead.mockImplementation(async (work: (tx: { run: (q: string, p: unknown) => unknown }) => unknown) =>
      work({ run: (_q, p) => {
        params = p
        return { records: [record({
          relations: [node({ relationship_type: 'DEPENDS_ON', direction: 'incoming', label: 'Depends on', target_type: 'application' }), null],
          systemRelations: [node({ relationship_type: 'OWNED_BY', label: 'Owner', target_entity: 'Team' }), null],
        })] }
      } }))
    const rels = await getNavigableRelations('server', 'Server', 't1')
    expect(params).toEqual({ entityType: 'server', tenantId: 't1' })
    expect(rels).toEqual([
      { relationshipType: 'DEPENDS_ON', direction: 'incoming', label: 'Depends on', targetEntityType: 'application', targetLabel: 'Application', targetNeo4jLabel: 'Application' },
      { relationshipType: 'OWNED_BY', direction: 'outgoing', label: 'Owner', targetEntityType: 'Team', targetLabel: 'Team', targetNeo4jLabel: 'Team' },
    ])
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('an unknown CI type has no relations (and the session is closed)', async () => {
    session.executeRead.mockResolvedValue({ records: [] })
    await expect(getNavigableRelations('ghost', 'Ghost', 't1')).resolves.toEqual([])
    expect(session.close).toHaveBeenCalledOnce()
  })
})
