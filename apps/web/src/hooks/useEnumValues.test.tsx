/**
 * THE VALUES OF AN ENUM FIELD, FROM THE CUSTOMER'S METAMODEL.
 *
 * The create pages, the SLA policies and the automation offer a field's
 * values (priority, category…) from the metamodel: the ITIL types for
 * tickets, the CI types for the CMDB — one query or the other, never both.
 * Anything that is not an enum field of a known type gives no values rather
 * than a guessed list, and a failed load is reported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useEnumValues } from './useEnumValues'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', fields: [
    { name: 'priority', fieldType: 'enum', enumValues: ['low', 'high'] },
    { name: 'category', fieldType: 'enum', enumValues: null },
    { name: 'title', fieldType: 'string', enumValues: null },
  ] }] }
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', fields: [
    { name: 'environment', fieldType: 'enum', enumValues: ['production', 'staging'] },
  ] }] }
})

const values = (entity: string, field: string) => renderHook(() => useEnumValues(entity, field)).result.current

describe('useEnumValues', () => {
  it('a ticket field reads from the ITIL types, and only those are asked', () => {
    expect(values('incident', 'priority')).toEqual({ values: ['low', 'high'], loading: false, error: null })
    expect(apolloFinto.chiamate['GetITILTypes']).toHaveLength(1)
    expect(apolloFinto.chiamate['GetCITypes']).toBeUndefined()
  })

  it('a CI field reads from the CI types, and only those are asked', () => {
    expect(values('server', 'environment').values).toEqual(['production', 'staging'])
    expect(apolloFinto.chiamate['GetCITypes']).toHaveLength(1)
    expect(apolloFinto.chiamate['GetITILTypes']).toBeUndefined()
  })

  it('no values for a field that is not an enum, an enum without values, an unknown field or an unknown type', () => {
    expect(values('incident', 'title').values).toEqual([])
    expect(values('incident', 'category').values).toEqual([])
    expect(values('incident', 'nonexistent').values).toEqual([])
    expect(values('router', 'environment').values).toEqual([])
  })

  it('before the metamodel arrives there are no values; a failure is reported', () => {
    delete apolloFinto.risposte['GetITILTypes']
    expect(values('incident', 'priority').values).toEqual([])
    apolloFinto.erroriQuery['GetCITypes'] = new Error('metamodel down')
    expect(values('server', 'environment').error?.message).toBe('metamodel down')
  })
})
