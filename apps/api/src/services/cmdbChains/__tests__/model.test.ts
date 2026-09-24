/**
 * THE CMDB CHAINS' RULES (owner, 24 Sep 2026).
 *
 * What the owner said, pinned:
 *  - a chain says which relations between CIs are admitted: a tree of types
 *    from a root, each link a relation the metamodel declares between them,
 *    every link required — an alternative is another chain;
 *  - two types can be linked only when they share a chain family (an
 *    application type and one that is both: yes; an application type and an
 *    infrastructure one: no);
 *  - a chain is application (every type of the Application family),
 *    infrastructure (every type of the Infrastructure family) or mixed.
 * And what a save must refuse, with the reason, before anything is written.
 */
import { describe, it, expect } from 'vitest'
import { admittedRelationKeys, linkOptions, validateChainInput, type ChainInput, type ChainNodeInput, type CmdbChain } from '../model.js'
import { CMDB_STARTING_CHAINS_1120 as CMDB_STARTING_CHAINS } from '../../../scripts/migrations/20261011_1120_dynamic_groups_outside_chains.js'
import { STARTING_CHAINS } from '../../../lib/cmdbStartingChains.js'
import { TYPES } from './fixtures.js'

const root = (ciType: string, id = 'root'): ChainNodeInput => ({ id, parentId: null, ciType })
const link = (id: string, parentId: string, ciType: string, relationType: string, direction = 'outgoing', required?: boolean): ChainNodeInput =>
  ({ id, parentId, ciType, relationType, direction, required })
const chain = (nodes: ChainNodeInput[], kind = 'application', name = 'Apps'): ChainInput => ({ name, kind, nodes })
const refusal = (input: ChainInput) => {
  try { validateChainInput(input, TYPES) } catch (e) { return (e as { extensions: { i18n: { key: string; params: Record<string, unknown> } } }).extensions.i18n }
  throw new Error('the chain was accepted')
}

describe('a valid chain', () => {
  it('is saved as drawn: the name trimmed, the root without a link, every link required', () => {
    const out = validateChainInput(chain([
      root('business_application'),
      link('app', 'root', 'application', 'REALIZES', 'outgoing', true),
      link('srv', 'app', 'server', 'HOSTED_ON'),
      // A certificate installed on the server: the certificate is the relation's source.
      link('cert', 'srv', 'certificate', 'INSTALLED_ON', 'incoming'),
    ], 'application', '  Application services  '), TYPES)
    expect(out.name).toBe('Application services')
    expect(out.kind).toBe('application')
    expect(out.nodes).toEqual([
      { id: 'root', parentId: null, ciType: 'business_application', relationType: null, direction: null, required: true },
      { id: 'app', parentId: 'root', ciType: 'application', relationType: 'REALIZES', direction: 'outgoing', required: true },
      { id: 'srv', parentId: 'app', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true },
      { id: 'cert', parentId: 'srv', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming', required: true },
    ])
  })

  it('the three starting chains the migrations wrote for every tenant pass the same rules', () => {
    for (const c of CMDB_STARTING_CHAINS) expect(() => validateChainInput(c, TYPES), c.name).not.toThrow()
  })

  it('a new tenant is born with the chains the existing ones have (a change there needs a migration here)', () => {
    expect(STARTING_CHAINS).toEqual(CMDB_STARTING_CHAINS)
  })

  it('the owner\'s rules of 24 Sep 2026: every link of every starting chain required; the alternatives are chains of their own', () => {
    expect(STARTING_CHAINS.every((c) => c.nodes.every((n) => n.required))).toBe(true)
    const shapes = STARTING_CHAINS.filter((c) => c.name.startsWith('Applications')).map((c) => c.nodes.filter((n) => n.parentId).map((n) => `${n.relationType!}→${n.ciType}`).join(' '))
    expect(shapes).toEqual([
      'REALIZES→application HOSTED_ON→server',
      'REALIZES→application HOSTED_ON→server INSTALLED_ON→certificate',
      'REALIZES→application DEPENDS_ON→database DEPENDS_ON→database_instance HOSTED_ON→server',
      'REALIZES→application DEPENDS_ON→database DEPENDS_ON→database_instance HOSTED_ON→server INSTALLED_ON→certificate',
      'REALIZES→application DEPENDS_ON→database DEPENDS_ON→database_instance HOSTED_ON→server USES_CERTIFICATE→certificate INSTALLED_ON→server',
      'REALIZES→application USES_CERTIFICATE→certificate INSTALLED_ON→server',
      'REALIZES→application DEPENDS_ON→application',
    ])
    // No certificate is installed on an instance: the instance uses it.
    expect(STARTING_CHAINS.some((c) => c.nodes.some((n) => n.relationType === 'INSTALLED_ON' && n.parentId === 'db-instance'))).toBe(false)
    // Dynamic groups have no chain (owner, 24 Sep 2026): an aggregator of CIs that follow theirs.
    expect(STARTING_CHAINS.some((c) => c.nodes.some((n) => n.ciType === 'dynamic_ci_group'))).toBe(false)
  })

  it('a link marked optional is refused: an alternative is another chain', () => {
    expect(refusal(chain([root('application'), link('srv', 'root', 'server', 'HOSTED_ON', 'outgoing', false)])))
      .toEqual({ key: 'errors.cmdbChain.linkOptional', params: { type: 'Server' } })
  })
})

describe('the families bound the drawing (the owner\'s words)', () => {
  it('an application type and an infrastructure one cannot be linked, even when the metamodel declares the relation', () => {
    // The application declares DEPENDS_ON → any; the families still say no.
    expect(refusal(chain([root('application'), link('sw', 'root', 'network_switch', 'DEPENDS_ON')], 'mixed')))
      .toEqual({ key: 'errors.cmdbChain.noSharedFamily', params: { parent: 'Application', child: 'NetworkSwitch' } })
  })

  it('a type of both families links to either: application → server → switch is a mixed chain', () => {
    expect(() => validateChainInput(chain([
      root('application'), link('srv', 'root', 'server', 'HOSTED_ON'), link('sw', 'srv', 'network_switch', 'DEPENDS_ON'),
    ], 'mixed'), TYPES)).not.toThrow()
  })

  it('an application chain takes only Application types, an infrastructure chain only Infrastructure ones', () => {
    expect(refusal(chain([root('server'), link('sw', 'root', 'network_switch', 'DEPENDS_ON')], 'application')))
      .toEqual({ key: 'errors.cmdbChain.typeNotInKind', params: { type: 'NetworkSwitch', kind: 'application' } })
    expect(refusal(chain([root('application'), link('srv', 'root', 'server', 'HOSTED_ON')], 'infrastructure')))
      .toEqual({ key: 'errors.cmdbChain.typeNotInKind', params: { type: 'Application', kind: 'infrastructure' } })
    expect(() => validateChainInput(chain([root('server'), link('sw', 'root', 'network_switch', 'DEPENDS_ON')], 'infrastructure'), TYPES)).not.toThrow()
  })

  it('a type with no family cannot sit in any chain, and the refusal says where to give it one', () => {
    expect(refusal(chain([root('floor_plan')], 'mixed'))).toEqual({ key: 'errors.cmdbChain.typeWithoutFamily', params: { type: 'FloorPlan' } })
  })
})

describe('what a save refuses', () => {
  it('a relation the metamodel does not declare between the two types, named in its own direction', () => {
    // The certificate is used by applications and databases only.
    expect(refusal(chain([root('business_application'), link('cert', 'root', 'certificate', 'USES_CERTIFICATE')])))
      .toEqual({ key: 'errors.cmdbChain.relationNotDeclared', params: { relation: 'USES_CERTIFICATE', source: 'BusinessApplication', target: 'Certificate' } })
    // The direction matters: a business application realizes an application, not the other way round.
    expect(refusal(chain([root('business_application'), link('app', 'root', 'application', 'REALIZES', 'incoming')])))
      .toMatchObject({ key: 'errors.cmdbChain.relationNotDeclared', params: { source: 'Application', target: 'BusinessApplication' } })
  })

  it('the shape of the tree: one root, known parents, no loops, unique ids', () => {
    expect(refusal(chain([]))).toMatchObject({ key: 'errors.cmdbChain.noRoot' })
    expect(refusal(chain([root('application'), root('server', 'r2')], 'mixed'))).toMatchObject({ key: 'errors.cmdbChain.oneRoot', params: { count: 2 } })
    expect(refusal(chain([root('application'), link('a', 'nowhere', 'server', 'HOSTED_ON')]))).toMatchObject({ key: 'errors.cmdbChain.unknownParent' })
    expect(refusal(chain([root('application'), link('a', 'b', 'server', 'HOSTED_ON'), link('b', 'a', 'server', 'HOSTED_ON')])))
      .toMatchObject({ key: 'errors.cmdbChain.cycle' })
    expect(refusal(chain([root('application'), link('root', 'root', 'server', 'HOSTED_ON')]))).toMatchObject({ key: 'errors.cmdbChain.duplicateNodeId' })
    expect(refusal(chain([root('application', '')]))).toMatchObject({ key: 'errors.cmdbChain.badNodeId' })
    expect(refusal(chain([root('application', 'x'.repeat(65))]))).toMatchObject({ key: 'errors.cmdbChain.badNodeId' })
  })

  it('a link without its relation or its direction, and the same link twice under one type', () => {
    expect(refusal(chain([root('application'), link('a', 'root', 'server', ' ')]))).toMatchObject({ key: 'errors.cmdbChain.relationRequired' })
    expect(refusal(chain([root('application'), link('a', 'root', 'server', 'HOSTED_ON', 'sideways')]))).toMatchObject({ key: 'errors.cmdbChain.unknownDirection' })
    expect(refusal(chain([root('application'), link('a', 'root', 'server', 'HOSTED_ON'), link('b', 'root', 'server', 'HOSTED_ON')])))
      .toMatchObject({ key: 'errors.cmdbChain.duplicateLink', params: { parent: 'Application', child: 'Server' } })
  })

  it('the name, the kind, an unknown type and too many types', () => {
    expect(refusal(chain([root('application')], 'application', '   '))).toMatchObject({ key: 'errors.cmdbChain.nameRequired' })
    expect(refusal(chain([root('application')], 'application', 'x'.repeat(81)))).toMatchObject({ key: 'errors.cmdbChain.nameTooLong', params: { max: 80 } })
    expect(refusal(chain([root('application')], 'hybrid'))).toMatchObject({ key: 'errors.cmdbChain.unknownKind', params: { kind: 'hybrid' } })
    expect(refusal(chain([root('toaster')]))).toMatchObject({ key: 'errors.cmdbChain.unknownType', params: { type: 'toaster' } })
    const many = [root('application'), ...Array.from({ length: 60 }, (_, i) => link(`s${String(i)}`, 'root', 'server', 'HOSTED_ON'))]
    expect(refusal(chain(many))).toMatchObject({ key: 'errors.cmdbChain.tooManyNodes', params: { max: 60 } })
  })
})

describe('what the chains admit', () => {
  const saved = (nodes: ChainNodeInput[], kind = 'application'): CmdbChain => ({ id: 'c', createdAt: null, updatedAt: null, ...validateChainInput(chain(nodes, kind), TYPES) })

  it('each link as `Source|RELATION|Target`, in the relation\'s own direction, across every chain', () => {
    const keys = admittedRelationKeys([
      saved([root('business_application'), link('app', 'root', 'application', 'REALIZES'), link('srv', 'app', 'server', 'HOSTED_ON'), link('cert', 'srv', 'certificate', 'INSTALLED_ON', 'incoming')]),
      saved([root('business_capability'), link('child', 'root', 'business_capability', 'PARENT_OF')]),
    ], TYPES)
    expect([...keys]).toEqual([
      'BusinessApplication|REALIZES|Application', 'Application|HOSTED_ON|Server', 'Certificate|INSTALLED_ON|Server', 'BusinessCapability|PARENT_OF|BusinessCapability',
    ])
  })

  it('a chain whose type left the metamodel admits nothing through it — the rest of it still counts', () => {
    const c = saved([root('application'), link('srv', 'root', 'server', 'HOSTED_ON'), link('cert', 'srv', 'certificate', 'INSTALLED_ON', 'incoming')])
    const keys = admittedRelationKeys([c], TYPES.filter((t) => t.name !== 'server'))
    expect([...keys]).toEqual([])
    expect([...admittedRelationKeys([c], TYPES.filter((t) => t.name !== 'certificate'))]).toEqual(['Application|HOSTED_ON|Server'])
  })
})

describe('what the editor offers below a type', () => {
  it('every relation the metamodel declares, both directions, toward the types the families and the kind allow', () => {
    const below = linkOptions(TYPES, 'server', 'mixed')
    // The switch is Infrastructure only: fine below a server (both families) in a mixed chain.
    expect(below).toContainEqual({ relationType: 'DEPENDS_ON', direction: 'outgoing', ciType: 'network_switch' })
    // A certificate installed on the server.
    expect(below).toContainEqual({ relationType: 'INSTALLED_ON', direction: 'incoming', ciType: 'certificate' })
    // The type without families is never offered.
    expect(below.some((o) => o.ciType === 'floor_plan')).toBe(false)
    // In an application chain the switch is not offered at all.
    expect(linkOptions(TYPES, 'server', 'application').some((o) => o.ciType === 'network_switch')).toBe(false)
    // Below an application: never the switch, whatever the kind.
    expect(linkOptions(TYPES, 'application', 'mixed').some((o) => o.ciType === 'network_switch')).toBe(false)
    expect(linkOptions(TYPES, 'application', 'application')).toContainEqual({ relationType: 'HOSTED_ON', direction: 'outgoing', ciType: 'server' })
  })

  it('every option offered is one a save accepts', () => {
    for (const kind of ['application', 'infrastructure', 'mixed'] as const) {
      for (const parent of ['application', 'server', 'business_application']) {
        const parentType = TYPES.find((t) => t.name === parent)!
        if (kind === 'infrastructure' && !parentType.chainFamilies!.includes('Infrastructure')) continue
        for (const o of linkOptions(TYPES, parent, kind)) {
          expect(() => validateChainInput(chain([root(parent), link('x', 'root', o.ciType, o.relationType, o.direction)], kind), TYPES), `${kind} ${parent} ${JSON.stringify(o)}`).not.toThrow()
        }
      }
    }
  })

  it('an unknown type is refused, not answered with nothing', () => {
    expect(() => linkOptions(TYPES, 'toaster', 'mixed')).toThrow(/not an active CI type/)
  })
})
