/**
 * THE WALK OF THE CHAINS over the CIs a tenant really has.
 *
 * What these pin, the owner's model of 24 Sep 2026 — every link required, a
 * chain used whole or another one («se sfrutto quell'albero, lo sfrutto
 * tutto, altrimenti cambio albero»):
 *  - a chain reaches through a retired CI as through any other: the walk
 *    ignores status, the counts leave the retired out;
 *  - a CI is fine when, where the chains first place it, one of them is
 *    followed whole below it; a type with nothing below asks nothing;
 *  - an incomplete CI names, chain by chain, the first link it lacks;
 *  - the coverage of a chain is how many of its roots follow it whole;
 *  - the roots of a type are read once, however many chains start there;
 *  - a type gone from the metamodel ends the chain there, without failing.
 * The graph is a stand-in that answers the three literal queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn() }))
const { runQuery } = await import('@opengraphity/neo4j')
const { evaluateChains } = await import('../evaluate.js')
import type { ChainNode, CmdbChain } from '../model.js'
import { TYPES } from './fixtures.js'

const LABEL: Record<string, string> = { BA: 'BusinessApplication', APP: 'Application', SRV: 'Server', DB: 'Database', INS: 'DatabaseInstance', CER: 'Certificate' }
/** id → status; the label is the id's prefix. */
const CIS: Record<string, string> = {
  BA1: 'active', BA2: 'decommissioned', BA3: 'active',
  APP1: 'active', APP2: 'active', APP3: 'decommissioned', APP4: 'active', APP5: 'active',
  SRV1: 'active', SRV2: 'decommissioned', SRV3: 'active', SRV4: 'active', SRV9: 'active',
  DB1: 'active', CER1: 'active',
}
const EDGES: Array<[string, string, string]> = [
  ['BA1', 'REALIZES', 'APP1'], ['BA1', 'REALIZES', 'APP2'], ['BA1', 'REALIZES', 'APP3'],
  // A retired business application: its application is still in the chain.
  ['BA2', 'REALIZES', 'APP4'],
  ['BA3', 'REALIZES', 'APP5'],
  ['APP1', 'HOSTED_ON', 'SRV1'],
  // Only a decommissioned server: the application in service is incomplete.
  ['APP2', 'HOSTED_ON', 'SRV2'],
  ['APP4', 'HOSTED_ON', 'SRV3'],
  ['APP5', 'HOSTED_ON', 'SRV4'],
  // A database with no instance: incomplete.
  ['APP1', 'DEPENDS_ON', 'DB1'],
  ['CER1', 'INSTALLED_ON', 'SRV1'],
]
const labelOf = (id: string) => LABEL[id.replace(/\d+$/, '')]!

const node = (id: string, parentId: string | null, ciType: string, relationType: string | null = null, direction: ChainNode['direction'] = null): ChainNode =>
  ({ id, parentId, ciType, relationType, direction, required: true })
const chainOf = (id: string, nodes: ChainNode[]): CmdbChain => ({ id, name: `Chain ${id}`, kind: 'application', nodes, createdAt: null, updatedAt: null })
const app = [node('ba', null, 'business_application'), node('app', 'ba', 'application', 'REALIZES', 'outgoing')]
/** Three alternatives: an application on a server, on a server with a certificate installed, on a database with its instance. */
const ON_SERVER = chainOf('s', [...app, node('srv', 'app', 'server', 'HOSTED_ON', 'outgoing')])
const ON_SERVER_CERT = chainOf('c', [...app, node('srv', 'app', 'server', 'HOSTED_ON', 'outgoing'), node('cert', 'srv', 'certificate', 'INSTALLED_ON', 'incoming')])
const ON_DATABASE = chainOf('d', [...app, node('db', 'app', 'database', 'DEPENDS_ON', 'outgoing'), node('ins', 'db', 'database_instance', 'DEPENDS_ON', 'outgoing')])
const CHAINS = [ON_SERVER, ON_SERVER_CERT, ON_DATABASE]
const RETIRED = ['decommissioned', 'expired']

beforeEach(() => {
  vi.mocked(runQuery).mockReset()
  vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string, p: Record<string, unknown>) => {
    const retired = p['retired'] as string[]
    if (cypher.includes('UNWIND $ids')) {
      const outgoing = cypher.includes(')-[r]->(c')
      const rows: unknown[] = []
      for (const pid of p['ids'] as string[]) {
        for (const [a, r, b] of EDGES) {
          const [parent, child] = outgoing ? [a, b] : [b, a]
          if (r === p['relationType'] && parent === pid && labelOf(child) === p['label']) rows.push({ parent: pid, child, inService: !retired.includes(CIS[child]!) })
        }
      }
      return rows
    }
    return Object.keys(CIS).filter((id) => labelOf(id) === p['label']).map((id) => ({ id, inService: !retired.includes(CIS[id]!) }))
  }) as never)
})

describe('evaluateChains', () => {
  it('reaches from every root along the links, through retired CIs too; what no root reaches is not reached', async () => {
    const out = await evaluateChains({} as never, 't1', CHAINS, TYPES, RETIRED)
    expect([...out.reached].sort()).toEqual(['APP1', 'APP2', 'APP3', 'APP4', 'APP5', 'BA1', 'BA2', 'BA3', 'CER1', 'DB1', 'SRV1', 'SRV2', 'SRV3', 'SRV4'])
    expect(out.reached.has('SRV9')).toBe(false)
    expect(out.drawnLabels.sort()).toEqual(['Application', 'BusinessApplication', 'Certificate', 'Database', 'DatabaseInstance', 'Server'])
  })

  it('a CI is fine when one chain is followed whole below it: a server without a certificate follows the first, the one with it the second', async () => {
    const out = await evaluateChains({} as never, 't1', CHAINS, TYPES, RETIRED)
    // APP1 on SRV1 (which has CER1) and with DB1: fine. APP4, APP5 on their servers: fine.
    for (const id of ['APP1', 'APP4', 'APP5', 'BA1', 'BA3', 'SRV1', 'SRV4', 'CER1']) expect(out.incomplete.has(id), id).toBe(false)
    expect([...out.incomplete.keys()].sort()).toEqual(['APP2', 'DB1'])
  })

  it('an incomplete CI names, chain by chain, the first link it lacks — as the alternatives they are', async () => {
    const out = await evaluateChains({} as never, 't1', CHAINS, TYPES, RETIRED)
    // APP2: only a retired server, no database — none of the three.
    expect(out.incomplete.get('APP2')).toEqual([
      { chain: 'Chain s', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing' },
      { chain: 'Chain c', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing' },
      { chain: 'Chain d', ciType: 'database', relationType: 'DEPENDS_ON', direction: 'outgoing' },
    ])
    // DB1: a database stands only in the database chain, and there it needs its instance.
    expect(out.incomplete.get('DB1')).toEqual([{ chain: 'Chain d', ciType: 'database_instance', relationType: 'DEPENDS_ON', direction: 'outgoing' }])
    // Looked at: the CIs in service placed where something is asked. A server is placed first where it ends a chain.
    expect([...out.checkedForLinks].sort()).toEqual(['APP1', 'APP2', 'APP4', 'APP5', 'BA1', 'BA3', 'DB1'])
  })

  it('a missing link deep down is named where it is missing, not at the top', async () => {
    const out = await evaluateChains({} as never, 't1', [ON_SERVER_CERT], TYPES, RETIRED)
    // APP5 stands on SRV4, which has no certificate: the certificate is what is missing.
    expect(out.incomplete.get('APP5')).toEqual([{ chain: 'Chain c', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming' }])
  })

  it('coverage: the roots in service, and how many follow the chain whole', async () => {
    const out = await evaluateChains({} as never, 't1', CHAINS, TYPES, RETIRED)
    // On a server: BA1 and BA3. With a certificate: BA1 only (SRV1 has CER1). On a database: none (DB1 has no instance).
    expect(out.coverage.map((c) => [c.chainId, c.roots, c.complete])).toEqual([['s', 2, 2], ['c', 2, 1], ['d', 2, 0]])
  })

  it('the roots of a type are read once for every chain that starts there', async () => {
    await evaluateChains({} as never, 't1', CHAINS, TYPES, RETIRED)
    expect(vi.mocked(runQuery).mock.calls.filter(([, c]) => !(c as string).includes('UNWIND'))).toHaveLength(1)
  })

  it('a type gone from the metamodel ends the chain there; a chain whose root is gone reaches nothing', async () => {
    const out = await evaluateChains({} as never, 't1', [ON_SERVER], TYPES.filter((t) => t.name !== 'server'), RETIRED)
    expect(out.reached.has('SRV1')).toBe(false)
    expect(out.reached.has('APP1')).toBe(true)
    const rootless = await evaluateChains({} as never, 't1', [ON_SERVER], TYPES.filter((t) => t.name !== 'business_application'), RETIRED)
    expect(rootless.reached.size).toBe(0)
    expect(rootless.coverage).toEqual([{ chainId: 's', name: 'Chain s', kind: 'application', roots: 0, complete: 0 }])
  })

  it('a link below a type no CI reached asks nothing of the database', async () => {
    const lonely = chainOf('l', [node('cap', null, 'business_capability'), node('ba', 'cap', 'business_application', 'ENABLED_BY', 'outgoing')])
    const out = await evaluateChains({} as never, 't1', [lonely], TYPES, RETIRED)
    expect(vi.mocked(runQuery).mock.calls.some(([, c]) => (c as string).includes('UNWIND'))).toBe(false)
    expect(out.coverage[0]).toMatchObject({ roots: 0, complete: 0 })
  })

  it('every query is literal and tenant-scoped, the relation and the label as parameters', async () => {
    await evaluateChains({} as never, 't1', CHAINS, TYPES, RETIRED)
    for (const [, cypher, params] of vi.mocked(runQuery).mock.calls) {
      expect(cypher).toContain('{tenant_id: $tenantId')
      expect(cypher).not.toContain('${')
      expect(params).toMatchObject({ tenantId: 't1', retired: RETIRED })
    }
  })
})
