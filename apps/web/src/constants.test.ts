/**
 * THE ITIL ENTITY TYPES THE ADMIN PAGES OFFER.
 *
 * Auto-triggers and business rules let the administrator pick the entity a
 * rule works on from `ITIL_ENTITY_TYPES`; the automation vocabulary decides
 * what is an ITIL entity with its own list (`ITIL_ENTITIES`). If the two
 * lists drift apart, a rule can be written on a type the automation does not
 * treat as ITIL (its fields and operators would not be offered), or an ITIL
 * type cannot be chosen at all. They must name the same four types.
 */
import { describe, it, expect } from 'vitest'
import { ITIL_ENTITY_TYPES } from './constants'
import { ITIL_ENTITIES, isITILEntity } from '@/lib/automationOperators'

describe('ITIL_ENTITY_TYPES', () => {
  it('offers exactly the types the automation treats as ITIL', () => {
    expect(new Set(ITIL_ENTITY_TYPES)).toEqual(ITIL_ENTITIES)
    expect(ITIL_ENTITY_TYPES.every(isITILEntity)).toBe(true)
  })

  it('offers each type once, incident first', () => {
    expect(ITIL_ENTITY_TYPES).toEqual(['incident', 'change', 'problem', 'service_request'])
  })
})
