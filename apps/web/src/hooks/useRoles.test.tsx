/**
 * THE ORGANIZATION'S ROLES AND THEIR NAMES (wave 7 of «Nulla cablato»).
 *
 * A role is shown by the name the organization gave it; a factory role never
 * renamed is shown translated from its key; a key nobody knows is shown as it
 * is rather than dressed up; and «no role» is a dash. The list is asked only
 * of someone whose permissions let them read it (the same permissions the API
 * checks): anyone else gets an empty list and no request that would fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useRoleLabel, useRoles } from './useRoles'

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
      return held.has(nomeOperazione(doc)) && !opts?.skip ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const ROLES = [
  { key: 'admin', name: null, permissions: [], isFactory: true, userCount: 1 },
  { key: 'auditor', name: 'Internal auditor', permissions: [], isFactory: false, userCount: 2 },
]
const meWith = (permissions: string[]) => ({ me: { id: 'u1', name: 'X', email: 'x@acme.com', role: 'admin', roleName: null, permissions, slackId: null, emailNotifications: null, language: null, teams: [] } })

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  apolloFinto.risposte['GetRoles'] = { roles: ROLES }
})

describe('useRoleLabel', () => {
  it('the organization\'s name first, then the translation of a factory key, then the key itself; no role is a dash', () => {
    const { result } = renderHook(() => useRoleLabel())
    const label = result.current
    expect(label({ key: 'auditor', name: 'Internal auditor' })).toBe('Internal auditor')
    expect(label({ key: 'admin', name: null })).toBe('Admin')
    expect(label({ key: 'night_shift', name: null })).toBe('night_shift')
    expect(label(null)).toBe('—')
    expect(label(undefined)).toBe('—')
  })
})

describe('useRoles', () => {
  it.each(['admin.users', 'config.notifications', 'config.workflow', 'config.automation'])('with %s the roles are read', (permission) => {
    apolloFinto.risposte['GetMe'] = meWith([permission])
    const { result } = renderHook(() => useRoles())
    expect(result.current.roles).toEqual(ROLES)
    expect(apolloFinto.chiamate['GetRoles']).toHaveLength(1)
  })

  it('without any of those permissions nothing is asked, and the list is empty', () => {
    apolloFinto.risposte['GetMe'] = meWith(['incident.read'])
    const { result } = renderHook(() => useRoles())
    expect(result.current.roles).toEqual([])
    expect(apolloFinto.chiamate['GetRoles']).toBeUndefined()
  })

  it('labelOf names a role by its key, even one not in the list, and «no role» is a dash', () => {
    apolloFinto.risposte['GetMe'] = meWith(['admin.users'])
    const { result } = renderHook(() => useRoles())
    const { labelOf } = result.current
    expect(labelOf('auditor')).toBe('Internal auditor')
    expect(labelOf('admin')).toBe('Admin')
    expect(labelOf('viewer')).toBe('Viewer')
    expect(labelOf('ghost_role')).toBe('ghost_role')
    expect(labelOf(null)).toBe('—')
    expect(labelOf(undefined)).toBe('—')
  })

  it('is loading only while the list has not arrived, and reports a failure', () => {
    apolloFinto.risposte['GetMe'] = meWith(['admin.users'])
    held.add('GetRoles')
    const loading = renderHook(() => useRoles())
    expect(loading.result.current.loading).toBe(true)
    held.clear()
    apolloFinto.erroriQuery['GetRoles'] = new Error('roles unavailable')
    const failed = renderHook(() => useRoles())
    expect(failed.result.current.loading).toBe(false)
    expect(failed.result.current.error?.message).toBe('roles unavailable')
  })
})
