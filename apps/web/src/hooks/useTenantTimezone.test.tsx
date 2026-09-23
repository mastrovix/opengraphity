/**
 * THE ORGANIZATION'S TIME ZONE, for the date-and-time fields (F-13).
 *
 * Validation and release windows are planned in the organization's time zone,
 * not the browser's: an operator travelling abroad who types «22:00» must
 * schedule 22:00 for the customer. Until the answer arrives the zone is
 * `null`, and the field says it is using the browser's — late information is
 * better than a silent conversion. A zone the organization never set is also
 * `null`, never a guess.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useTenantTimezone } from './useTenantTimezone'

// The shared fake answers at once: a query named in `held` stays in flight.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
  }
})

beforeEach(() => { apolloFinto.reset(); held.clear() })

describe('useTenantTimezone', () => {
  it('is the organization\'s zone once it has arrived', () => {
    apolloFinto.risposte['GetTenantTimezoneSettings'] = { tenantTimezoneSettings: { timezone: 'America/New_York' } }
    const { result } = renderHook(() => useTenantTimezone())
    expect(result.current).toEqual({ timeZone: 'America/New_York', loading: false })
  })

  it('is null, and loading, until the answer arrives', () => {
    held.add('GetTenantTimezoneSettings')
    const { result } = renderHook(() => useTenantTimezone())
    expect(result.current).toEqual({ timeZone: null, loading: true })
  })

  it('is null when the organization never set one', () => {
    apolloFinto.risposte['GetTenantTimezoneSettings'] = { tenantTimezoneSettings: { timezone: null } }
    const { result } = renderHook(() => useTenantTimezone())
    expect(result.current.timeZone).toBeNull()
  })
})
