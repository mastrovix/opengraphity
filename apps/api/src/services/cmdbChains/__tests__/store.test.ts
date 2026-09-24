/**
 * The CMDB chains in Neo4j: one node each, the tree kept whole as JSON.
 *
 * What these pin: every query is tenant-scoped; a name is unique in the
 * tenant, case aside, and a rename to its own name is not a clash; a chain
 * that is not there is an error, not a silent no-op; a stored chain that does
 * not read back (unknown kind, broken JSON) fails loud with its id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn() }))
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { listChains, createChain, updateChain, deleteChain } = await import('../store.js')

const NODES = [{ id: 'r', parentId: null, ciType: 'application', relationType: null, direction: null, required: true }]
const row = (over: Record<string, unknown> = {}) =>
  ({ id: 'c1', name: 'Apps', kind: 'application', nodes: JSON.stringify(NODES), createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z', ...over })
const record = (r: Record<string, unknown>) => ({ toObject: () => r, get: (k: string) => r[k] })
const run = vi.fn()
const session = { executeWrite: vi.fn((fn: (tx: { run: typeof run }) => unknown) => fn({ run })) } as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQueryOne).mockResolvedValue(null)
  run.mockResolvedValue({ records: [record(row())] })
})

describe('listChains', () => {
  it('reads the tenant\'s chains in name order and parses each tree', async () => {
    vi.mocked(runQuery).mockResolvedValue([row()] as never)
    const out = await listChains(session, 't1')
    expect(out).toEqual([{ id: 'c1', name: 'Apps', kind: 'application', nodes: NODES, createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z' }])
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (c:CMDBChain {tenant_id: $tenantId})')
    expect(cypher).toContain('ORDER BY c.name_key')
    expect(params).toEqual({ tenantId: 't1' })
  })

  it('a stored chain that does not read back fails loud, naming it', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([row({ kind: 'hybrid' })] as never)
    await expect(listChains(session, 't1')).rejects.toThrow('CMDBChain c1 has kind "hybrid"')
    vi.mocked(runQuery).mockResolvedValueOnce([row({ nodes: '{broken' })] as never)
    await expect(listChains(session, 't1')).rejects.toThrow(/CMDBChain c1: nodes_json is not JSON/)
    vi.mocked(runQuery).mockResolvedValueOnce([row({ nodes: '{}' })] as never)
    await expect(listChains(session, 't1')).rejects.toThrow('CMDBChain c1: nodes_json is not a list')
  })
})

describe('createChain and updateChain', () => {
  const chain = { name: 'Apps', kind: 'application' as const, nodes: NODES as never }

  it('create writes the tree as JSON with its lowercase key, who and when', async () => {
    const out = await createChain(session, 't1', 'c1', chain, 'u1')
    expect(out.id).toBe('c1')
    const [cypher, params] = run.mock.calls[0]!
    expect(cypher).toContain('CREATE (c:CMDBChain {id: $id, tenant_id: $tenantId')
    expect(params).toMatchObject({ id: 'c1', tenantId: 't1', name: 'Apps', nameKey: 'apps', kind: 'application', nodes: JSON.stringify(NODES), by: 'u1' })
  })

  it('a name already taken in the tenant, case aside, is refused before writing', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ id: 'other' })
    await expect(createChain(session, 't1', 'c1', { ...chain, name: 'APPS' }, 'u1')).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.cmdbChain.nameTaken', params: { name: 'APPS' } } },
    })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ tenantId: 't1', nameKey: 'apps', exceptId: null })
    expect(run).not.toHaveBeenCalled()
  })

  it('update checks the name against the OTHER chains, and a chain that is not there is an error', async () => {
    await updateChain(session, 't1', 'c1', chain, 'u2')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toMatchObject({ exceptId: 'c1' })
    expect(run.mock.calls[0]![0]).toContain('MATCH (c:CMDBChain {id: $id, tenant_id: $tenantId})')
    run.mockResolvedValueOnce({ records: [] })
    await expect(updateChain(session, 't1', 'gone', chain, 'u2')).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('deleteChain', () => {
  it('removes the tenant\'s chain and gives back its name; one that is not there is an error', async () => {
    run.mockResolvedValueOnce({ records: [record({ name: 'Apps' })] })
    expect(await deleteChain(session, 't1', 'c1')).toBe('Apps')
    expect(run.mock.calls[0]![1]).toEqual({ id: 'c1', tenantId: 't1' })
    run.mockResolvedValueOnce({ records: [] })
    await expect(deleteChain(session, 't1', 'gone')).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})
