/**
 * The tree of a CMDB chain on the page: removing a type takes what hangs
 * below with it, a new link hangs where it was asked, the layout puts each
 * depth on its row and a parent over its children, the input sent to the API
 * carries nothing but its fields, and a relation is named in words from its
 * type.
 */
import { describe, it, expect } from 'vitest'
import { addLink, childrenOf, isChainKind, layoutTree, newNodeId, relationLabel, toChainInput, withoutSubtree, type ChainNode } from './chainModel'

const n = (id: string, parentId: string | null, ciType = 'server'): ChainNode =>
  ({ id, parentId, ciType, relationType: parentId ? 'HOSTED_ON' : null, direction: parentId ? 'outgoing' : null, required: false })
const TREE = [n('r', null, 'application'), n('a', 'r'), n('b', 'r'), n('a1', 'a', 'certificate'), n('a2', 'a', 'certificate')]

describe('the tree', () => {
  it('removing a type takes everything below it, and nothing else', () => {
    expect(withoutSubtree(TREE, 'a').map((x) => x.id)).toEqual(['r', 'b'])
    expect(withoutSubtree(TREE, 'a2').map((x) => x.id)).toEqual(['r', 'a', 'b', 'a1'])
    expect(childrenOf(TREE, 'r').map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('a new link hangs below the type asked, required as every link is', () => {
    const out = addLink(TREE, 'b', { relationType: 'INSTALLED_ON', direction: 'incoming', ciType: 'certificate' }, 'new')
    expect(out.at(-1)).toEqual({ id: 'new', parentId: 'b', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming', required: true })
    expect(newNodeId()).toMatch(/^n-[0-9a-f]{8}$/)
  })

  it('the layout: a row per depth, the leaves side by side, a parent centred over its children', () => {
    const at = layoutTree(TREE, 100, 50)
    expect(at.get('a1')).toEqual({ x: 0, y: 100 })
    expect(at.get('a2')).toEqual({ x: 100, y: 100 })
    expect(at.get('a')).toEqual({ x: 50, y: 50 })
    expect(at.get('b')).toEqual({ x: 200, y: 50 })
    expect(at.get('r')).toEqual({ x: 125, y: 0 })
    expect(layoutTree([]).size).toBe(0)
  })

  it('a type whose parent is not in the tree is not placed (the drawing never loops)', () => {
    expect(layoutTree([n('r', null), n('lost', 'nowhere')]).has('lost')).toBe(false)
  })
})

describe('what goes to the API and what the page says', () => {
  it('the input carries only its fields — not what Apollo added', () => {
    const withTypename = { ...TREE[1]!, __typename: 'CmdbChainNode' } as ChainNode
    expect(toChainInput({ id: 'c1', name: 'Apps', kind: 'mixed', nodes: [withTypename] })).toEqual({
      name: 'Apps', kind: 'mixed', nodes: [{ id: 'a', parentId: 'r', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: false }],
    })
  })

  it('a relation is named in words from its type: beside an arrow it reads the relation\'s way', () => {
    expect(relationLabel('HOSTED_ON')).toBe('Hosted on')
    expect(relationLabel('USES_CERTIFICATE')).toBe('Uses certificate')
  })

  it('only the three kinds are kinds', () => {
    expect(['application', 'infrastructure', 'mixed', 'hybrid'].map(isChainKind)).toEqual([true, true, true, false])
  })
})
