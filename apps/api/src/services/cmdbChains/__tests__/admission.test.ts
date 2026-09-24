/**
 * IS THIS RELATION ADMITTED? The one answer for every way a relation between
 * CIs is born (the mutation, discovery, a sync conflict).
 *
 * What these pin:
 *  - a relation is admitted when some chain draws it between the two types,
 *    in its own direction; any label of either CI may be the type;
 *  - the chains govern the relations between the types they draw: a type no
 *    chain draws (a dynamic group) follows the metamodel alone;
 *  - chains and metamodel are read once per admission, asked many times.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel: vi.fn() }))
vi.mock('../store.js', () => ({ listChains: vi.fn() }))
const { loadMetamodel } = await import('@opengraphity/schema-generator')
const { listChains } = await import('../store.js')
const { relationAdmission, assertRelationAdmitted, notAdmittedError } = await import('../admission.js')
import { TYPES } from './fixtures.js'

const CHAIN = {
  id: 'c1', name: 'Apps', kind: 'application', createdAt: null, updatedAt: null,
  nodes: [
    { id: 'app', parentId: null, ciType: 'application', relationType: null, direction: null, required: true },
    { id: 'srv', parentId: 'app', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true },
    { id: 'cert', parentId: 'srv', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming', required: false },
  ],
}
const APP = ['ConfigurationItem', 'Application']
const SRV = ['ConfigurationItem', 'Server']
const CERT = ['ConfigurationItem', 'Certificate']
const session = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadMetamodel).mockResolvedValue(TYPES as never)
  vi.mocked(listChains).mockResolvedValue([CHAIN] as never)
})

describe('relationAdmission', () => {
  it('admits what a chain draws, in its own direction, and nothing else', async () => {
    const a = await relationAdmission(session, 't1')
    expect(a.chains).toBe(1)
    expect(a.admits('HOSTED_ON', APP, SRV)).toBe(true)
    expect(a.admits('INSTALLED_ON', CERT, SRV)).toBe(true)
    // The other way round is another relation.
    expect(a.admits('HOSTED_ON', SRV, APP)).toBe(false)
    expect(a.admits('DEPENDS_ON', APP, SRV)).toBe(false)
    expect(listChains).toHaveBeenCalledOnce()
    expect(loadMetamodel).toHaveBeenCalledOnce()
  })
})

describe('the refusal', () => {
  it('names the relation and the two types, and where to draw it', async () => {
    await expect(assertRelationAdmitted(session, 't1', 'DEPENDS_ON', APP, SRV)).rejects.toMatchObject({
      message: expect.stringContaining('CMDB Health → Chains'),
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.cmdbChain.relationNotAdmitted', params: { relation: 'DEPENDS_ON', source: 'Application', target: 'Server' } } },
    })
    await expect(assertRelationAdmitted(session, 't1', 'HOSTED_ON', APP, SRV)).resolves.toBeUndefined()
  })

  it('a type no chain draws is outside the chains: its relations follow the metamodel alone (a dynamic group, 24 Sep 2026)', async () => {
    const a = await relationAdmission(session, 't1')
    const GROUP = ['ConfigurationItem', 'DynamicCIGroup']
    expect(a.admits('HAS_MEMBER', GROUP, SRV)).toBe(true)
    expect(a.admits('DEPENDS_ON', APP, ['ConfigurationItem', 'NetworkSwitch'])).toBe(true)
    // Between two drawn types the chains decide.
    expect(a.admits('DEPENDS_ON', APP, SRV)).toBe(false)
    // With no chain at all, nothing is drawn: the metamodel alone.
    vi.mocked(listChains).mockResolvedValue([] as never)
    expect((await relationAdmission(session, 't1')).admits('DEPENDS_ON', APP, SRV)).toBe(true)
  })

  it('a CI with only the base label is named by it', () => {
    const err = notAdmittedError({ chains: 1, admits: () => false }, 'RELATED_TO', ['ConfigurationItem'], [])
    expect(err.extensions).toMatchObject({ i18n: { params: { source: 'ConfigurationItem', target: '?' } } })
  })
})
