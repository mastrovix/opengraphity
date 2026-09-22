/**
 * `useCIBaseEnums` is the ONLY source of the CI status and environment lists
 * (filters, forms, the CMDB table). It is fail-loud by contract: when the
 * metamodel does not provide a usable enum the lists are empty AND an error
 * message comes back for the caller to show. If it regressed to silently
 * returning empty lists, a user would see a status filter with no options and
 * no explanation; if it regressed to a hardcoded fallback, a tenant that added
 * `decommissioned` would never see it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCIBaseEnums } from './ciEnums'

const query = vi.hoisted(() => ({ result: { data: undefined as unknown, loading: false, error: undefined as Error | undefined } }))
vi.mock('@apollo/client/react', () => ({ useQuery: () => query.result }))

type Field = { name: string; fieldType: string; enumValues: string[] | null }
const answer = (fields: Field[] | null) => ({ baseCIType: fields ? { fields } : null })
const STATUS: Field = { name: 'status', fieldType: 'enum', enumValues: ['active', 'decommissioned'] }
const ENV: Field = { name: 'environment', fieldType: 'enum', enumValues: ['production', 'lab'] }

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  query.result = { data: undefined, loading: false, error: undefined }
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('useCIBaseEnums', () => {
  it('while loading: empty lists, loading, and no error yet', () => {
    query.result = { data: undefined, loading: true, error: undefined }
    expect(renderHook(() => useCIBaseEnums()).result.current).toEqual({ statuses: [], environments: [], loading: true, error: null })
  })

  it('returns the tenant values exactly as the metamodel lists them', () => {
    query.result = { data: answer([STATUS, ENV]), loading: false, error: undefined }
    expect(renderHook(() => useCIBaseEnums()).result.current).toEqual({
      statuses: ['active', 'decommissioned'], environments: ['production', 'lab'], loading: false, error: null,
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('a refetch in flight with data already there does not blank the lists', () => {
    query.result = { data: answer([STATUS, ENV]), loading: true, error: undefined }
    const r = renderHook(() => useCIBaseEnums()).result.current
    expect(r.loading).toBe(false)
    expect(r.statuses).toEqual(['active', 'decommissioned'])
  })

  it('a query error is returned for the caller to show, and logged', () => {
    query.result = { data: undefined, loading: false, error: new Error('network down') }
    expect(renderHook(() => useCIBaseEnums()).result.current).toEqual({ statuses: [], environments: [], loading: false, error: 'network down' })
    expect(consoleError).toHaveBeenCalledWith('[ciEnums] baseCIType not loaded:', 'network down')
  })

  it('no base type at all: both fields are reported missing', () => {
    query.result = { data: answer(null), loading: false, error: undefined }
    const r = renderHook(() => useCIBaseEnums()).result.current
    expect(r.statuses).toEqual([])
    expect(r.environments).toEqual([])
    expect(r.error).toBe('base field "status" is not in the metamodel · base field "environment" is not in the metamodel')
  })

  it('a field that is not an enum, or an enum without values, is an error — the valid one still comes through', () => {
    query.result = { data: answer([{ ...STATUS, fieldType: 'string' }, ENV]), loading: false, error: undefined }
    let r = renderHook(() => useCIBaseEnums()).result.current
    expect(r.statuses).toEqual([])
    expect(r.environments).toEqual(['production', 'lab'])
    expect(r.error).toBe('base field "status" is not an enum (string)')

    query.result = { data: answer([STATUS, { ...ENV, enumValues: [] }]), loading: false, error: undefined }
    r = renderHook(() => useCIBaseEnums()).result.current
    expect(r.statuses).toEqual(['active', 'decommissioned'])
    expect(r.error).toBe('base field "environment" has no enumValues')

    query.result = { data: answer([STATUS, { ...ENV, enumValues: null }]), loading: false, error: undefined }
    expect(renderHook(() => useCIBaseEnums()).result.current.error).toBe('base field "environment" has no enumValues')
    // Logged too: an empty filter must leave a trace for whoever investigates.
    expect(consoleError).toHaveBeenCalledWith('[ciEnums]', 'base field "environment" has no enumValues')
  })
})
