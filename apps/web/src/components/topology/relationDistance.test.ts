/**
 * EVERY RELATION TYPE THE METAMODEL DECLARES HAS A DISTANCE (D76, tour of
 * 23 Sep 2026): the map logged «unknown value: REALIZES / PARENT_OF /
 * ENABLED_BY» twenty times for relations the tenant's metamodel declares.
 * Only a type the metamodel does not declare may be reported — once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { declaredRelationTypes, linkDistance, relationDistance, DEFAULT_RELATION_DISTANCE, type CITypeRelations } from './relationDistance'

/** The shipped metamodel, as far as these relations go. */
const METAMODEL: CITypeRelations[] = [
  { relations: [{ relationshipType: 'DEPENDS_ON | HOSTED_ON' }, { relationshipType: 'REALIZES' }], systemRelations: [{ relationshipType: 'OWNED_BY' }] },
  { relations: [{ relationshipType: 'PARENT_OF' }, { relationshipType: 'ENABLED_BY' }] },
  { relations: [] },
]

afterEach(() => { vi.restoreAllMocks() })

describe('declaredRelationTypes', () => {
  it('collects the types of every relation and system relation, splitting the combined ones', () => {
    expect([...declaredRelationTypes(METAMODEL)!].sort()).toEqual(['DEPENDS_ON', 'ENABLED_BY', 'HOSTED_ON', 'OWNED_BY', 'PARENT_OF', 'REALIZES'])
  })

  it('without a metamodel (not loaded, or types without their relations) nothing is known', () => {
    expect(declaredRelationTypes(undefined)).toBeNull()
    expect(declaredRelationTypes([])).toBeNull()
    expect(declaredRelationTypes([{}, {}])).toBeNull()
  })
})

describe('the distance of a relation', () => {
  it('the three types with their own distance keep it', () => {
    const d = linkDistance(METAMODEL)
    expect(d({ relType: 'HOSTED_ON' })).toBe(80)
    expect(d({ relType: 'DEPENDS_ON' })).toBe(120)
  })

  it('a declared type without its own distance takes the default, and nothing is logged', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = linkDistance(METAMODEL)
    for (const relType of ['REALIZES', 'PARENT_OF', 'ENABLED_BY', 'REALIZES']) expect(d({ relType })).toBe(DEFAULT_RELATION_DISTANCE)
    expect(errors).not.toHaveBeenCalled()
  })

  it('a type the metamodel does not declare is reported ONCE per drawing, however many edges carry it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = linkDistance(METAMODEL)
    for (let i = 0; i < 20; i++) expect(d({ relType: 'MYSTERY_LINK' })).toBe(DEFAULT_RELATION_DISTANCE)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith('[EDGE_DIST] relation type not declared by the metamodel: "MYSTERY_LINK"')
  })

  it('while the metamodel is unknown nothing is called unknown', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(relationDistance('REALIZES', null, new Set())).toBe(DEFAULT_RELATION_DISTANCE)
    expect(errors).not.toHaveBeenCalled()
  })
})
