import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { SyncSourceConfig } from '@opengraphity/discovery'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))
vi.mock('@opengraphity/discovery', () => ({
  applyMappingRules: vi.fn((ci: unknown) => ci),
  inferCIType: vi.fn(() => 'server'),
  normalizeProperties: vi.fn((props: unknown) => props),
}))

const { reconcileBatch, assertDiscoveredPropertyKeys } = await import('../reconciliationEngine.js')
const { getSession } = await import('@opengraphity/neo4j')

// Session whose tx.run captures (query, params) so we can assert the SET shape.
function makeCapturingSession(reads: Record<string, unknown>[][] = []) {
  let readCall = 0
  const writes: Array<{ query: string; params: Record<string, unknown> }> = []
  const session = {
    executeRead: vi.fn().mockImplementation(() =>
      Promise.resolve({ records: (reads[readCall++] ?? []).map(r => ({ get: (k: string) => r[k] })) }),
    ),
    executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ run: (query: string, params: Record<string, unknown>) => { writes.push({ query, params }); return Promise.resolve({ records: [] }) } }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return { session, writes }
}

const source: SyncSourceConfig = {
  id: 'src-1', name: 'Test', connector_type: 'csv', config: {}, tenant_id: 'tenant-1', enabled: true,
  encrypted_credentials: '', mapping_rules: [], schedule_cron: null, last_sync_at: null,
  last_sync_status: null, last_sync_duration_ms: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}
const stats = () => ({ ciCreated: 0, ciUpdated: 0, ciUnchanged: 0, ciStale: 0, ciConflicts: 0, relationsCreated: 0, relationsRemoved: 0 })

describe('assertDiscoveredPropertyKeys (B-04)', () => {
  it.each([
    'foo}) DETACH DELETE ci //',
    'a b',
    'aws:cloudformation:stack-name',
    'Name',
    '_x',
  ])('rejects key %j with a ValidationError naming the CI', (key) => {
    let thrown: unknown
    try { assertDiscoveredPropertyKeys({ [key]: 1, ok: 2 }, 'ext-9') } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GraphQLError)
    expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
    expect((thrown as Error).message).toContain('ext-9')
    expect((thrown as Error).message).toContain(JSON.stringify(key))
  })

  it('accepts snake_case keys', () => {
    expect(() => assertDiscoveredPropertyKeys({ ip_address: '1', os: 'linux', cpu_count2: 4 }, 'x')).not.toThrow()
  })
})

describe('reconcileBatch uses parameter maps, never keys in the query text', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createCI: CREATE … SET ci += $props', async () => {
    const { session, writes } = makeCapturingSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await reconcileBatch([{
      external_id: 'ext-1', source: 'csv', ci_type: 'server', name: 'web-01',
      properties: { ip_address: '10.0.0.1', os: 'linux' }, tags: {}, relationships: [],
    }], source, 'run-1', 'tenant-1', stats())

    expect(writes).toHaveLength(1)
    expect(writes[0]!.query).toBe('CREATE (ci:ConfigurationItem:Server) SET ci += $props')
    expect(writes[0]!.params['props']).toMatchObject({
      ip_address: '10.0.0.1', os: 'linux', name: 'web-01', tenant_id: 'tenant-1', type: 'server',
      discovery_external_id: 'ext-1', discovery_source_id: 'src-1',
    })
  })

  it('updateCI: MATCH … SET ci += $updates', async () => {
    const existing = { id: 'ci-1', discovery_locked_fields: [], os: 'linux', ip_address: '10.0.0.1' }
    const { session, writes } = makeCapturingSession([[{ id: 'ci-1', props: existing }]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await reconcileBatch([{
      external_id: 'ext-1', source: 'csv', ci_type: 'server', name: 'web-01',
      properties: { ip_address: '10.0.0.1', os: 'ubuntu' }, tags: {}, relationships: [],
    }], source, 'run-1', 'tenant-1', stats())

    expect(writes[0]!.query).toBe('MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId}) SET ci += $updates')
    expect(writes[0]!.params).toMatchObject({ id: 'ci-1', tenantId: 'tenant-1', updates: { os: 'ubuntu', name: 'web-01', discovery_status: 'active' } })
  })

  it('a malicious discovered key aborts the run before any write', async () => {
    const { session, writes } = makeCapturingSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await expect(reconcileBatch([{
      external_id: 'ext-evil', source: 'csv', ci_type: 'server', name: 'x',
      properties: { 'foo}) DETACH DELETE ci //': 1 }, tags: {}, relationships: [],
    }], source, 'run-1', 'tenant-1', stats())).rejects.toThrow(/ext-evil/)

    expect(writes).toHaveLength(0)
  })
})
