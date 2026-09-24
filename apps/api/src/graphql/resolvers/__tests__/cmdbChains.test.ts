/**
 * THE CMDB CHAINS' API: read, drawn, removed.
 *
 * What these pin: a save is validated against the tenant's metamodel before
 * anything is written (a refused chain writes nothing and audits nothing);
 * every write is audited with the chain's name; the link options come from
 * the same rule the save applies; reading needs only cmdb.read, drawing
 * needs the metamodel permission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel: vi.fn() }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({ session: true })) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/cmdbChains/store.js', () => ({
  listChains: vi.fn(), createChain: vi.fn(), updateChain: vi.fn(), deleteChain: vi.fn(),
}))

const { loadMetamodel } = await import('@opengraphity/schema-generator')
const { withSession } = await import('../ci-utils.js')
const { audit } = await import('../../../lib/audit.js')
const store = await import('../../../services/cmdbChains/store.js')
const { cmdbChainsResolvers } = await import('../cmdbChains.js')
const { operationRequirement } = await import('../../../lib/operationPermissions.js')
import { TYPES } from '../../../services/cmdbChains/__tests__/fixtures.js'

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') }
const INPUT = {
  name: 'Apps', kind: 'application',
  nodes: [
    { id: 'r', parentId: null, ciType: 'application' },
    { id: 's', parentId: 'r', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true },
  ],
}
const SAVED = { id: 'c1', name: 'Apps', kind: 'application', nodes: [{}, {}], createdAt: null, updatedAt: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadMetamodel).mockResolvedValue(TYPES as never)
  vi.mocked(store.createChain).mockResolvedValue(SAVED as never)
  vi.mocked(store.updateChain).mockResolvedValue(SAVED as never)
  vi.mocked(store.deleteChain).mockResolvedValue('Apps')
})

describe('reading', () => {
  it('the chains of the caller\'s tenant', async () => {
    vi.mocked(store.listChains).mockResolvedValue([SAVED] as never)
    expect(await cmdbChainsResolvers.Query.cmdbChains(null, null, ctx as never)).toEqual([SAVED])
    expect(store.listChains).toHaveBeenCalledWith({ session: true }, 't1')
  })

  it('the links offered below a type, by the save\'s own rule; an unknown kind is refused', async () => {
    const out = await cmdbChainsResolvers.Query.cmdbChainLinkOptions(null, { ciType: 'application', kind: 'application' }, ctx as never)
    expect(out).toContainEqual({ relationType: 'HOSTED_ON', direction: 'outgoing', ciType: 'server' })
    await expect(cmdbChainsResolvers.Query.cmdbChainLinkOptions(null, { ciType: 'application', kind: 'hybrid' }, ctx as never))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.cmdbChain.unknownKind' } } })
  })
})

describe('drawing', () => {
  it('create validates, writes in a write session with a new id and who, and audits', async () => {
    expect(await cmdbChainsResolvers.Mutation.createCmdbChain(null, { input: INPUT }, ctx as never)).toBe(SAVED)
    const [, tenantId, id, chain, by] = vi.mocked(store.createChain).mock.calls[0]!
    expect([tenantId, by]).toEqual(['t1', 'u1'])
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(chain).toMatchObject({ name: 'Apps', kind: 'application', nodes: [{ parentId: null }, { relationType: 'HOSTED_ON', required: true }] })
    expect(vi.mocked(withSession).mock.calls.at(-1)![1]).toBe(true)
    expect(audit).toHaveBeenCalledWith(ctx, 'cmdb_chain.created', 'CMDBChain', 'c1', { name: 'Apps', kind: 'application', types: 2 })
  })

  it('a chain the rules refuse writes nothing and audits nothing', async () => {
    const bad = { ...INPUT, nodes: [INPUT.nodes[0]!, { ...INPUT.nodes[1]!, ciType: 'network_switch', relationType: 'DEPENDS_ON' }] }
    await expect(cmdbChainsResolvers.Mutation.createCmdbChain(null, { input: bad }, ctx as never)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    await expect(cmdbChainsResolvers.Mutation.updateCmdbChain(null, { id: 'c1', input: bad }, ctx as never)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(store.createChain).not.toHaveBeenCalled()
    expect(store.updateChain).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('update and delete write and audit, delete with the removed chain\'s name', async () => {
    await cmdbChainsResolvers.Mutation.updateCmdbChain(null, { id: 'c1', input: INPUT }, ctx as never)
    expect(vi.mocked(store.updateChain).mock.calls[0]!.slice(1, 3)).toEqual(['t1', 'c1'])
    expect(audit).toHaveBeenCalledWith(ctx, 'cmdb_chain.updated', 'CMDBChain', 'c1', { name: 'Apps', kind: 'application', types: 2 })
    expect(await cmdbChainsResolvers.Mutation.deleteCmdbChain(null, { id: 'c1' }, ctx as never)).toBe(true)
    expect(store.deleteChain).toHaveBeenCalledWith({ session: true }, 't1', 'c1')
    expect(audit).toHaveBeenCalledWith(ctx, 'cmdb_chain.deleted', 'CMDBChain', 'c1', { name: 'Apps' })
  })
})

describe('who may', () => {
  it('reading needs cmdb.read; drawing needs the metamodel permission', () => {
    expect(operationRequirement('Query', 'cmdbChains')).toEqual(['cmdb.read'])
    expect(operationRequirement('Query', 'cmdbChainLinkOptions')).toEqual(['cmdb.read'])
    for (const m of ['createCmdbChain', 'updateCmdbChain', 'deleteCmdbChain']) expect(operationRequirement('Mutation', m), m).toEqual(['config.metamodel'])
  })
})
