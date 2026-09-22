/**
 * lib/mappers.ts — graph properties → GraphQL shapes.
 *
 * Why these behaviours matter: Neo4j returns temporal values as structured
 * objects (with Integer parts), not strings. If `neo4jDateToISO` gets one
 * wrong, every "created at" in lists and exports shows a wrong or empty date;
 * if a mapper default regresses (e.g. `active` becoming undefined), users
 * silently disappear from pickers that filter on `active`.
 */
import { describe, it, expect } from 'vitest'
import { neo4jDateToISO, mapUser, mapIncident, mapTeam, toSnakeCase } from '../mappers.js'
import { ticketPropsOf } from '../ticketProps.js'

describe('neo4jDateToISO', () => {
  it('empty values are null, strings pass through untouched', () => {
    expect(neo4jDateToISO(null)).toBeNull()
    expect(neo4jDateToISO(undefined)).toBeNull()
    expect(neo4jDateToISO('')).toBeNull()
    expect(neo4jDateToISO('2026-09-22T10:00:00.000Z')).toBe('2026-09-22T10:00:00.000Z')
  })

  it('objects with toStandardDate() (driver DateTime) use it', () => {
    const val = { toStandardDate: () => new Date('2026-01-02T03:04:05.000Z') }
    expect(neo4jDateToISO(val)).toBe('2026-01-02T03:04:05.000Z')
  })

  it('plain structured dates with numeric parts; missing time parts default to midnight', () => {
    expect(neo4jDateToISO({ year: 2026, month: 3, day: 15, hour: 8, minute: 30, second: 12 }))
      .toBe(new Date(2026, 2, 15, 8, 30, 12).toISOString())
    // Month is 1-based in Neo4j and 0-based in JS: a Date-only value must not shift a month.
    expect(neo4jDateToISO({ year: 2026, month: 3, day: 15 })).toBe(new Date(2026, 2, 15, 0, 0, 0).toISOString())
  })

  it('structured dates whose parts are driver Integers ({low, high}) are read from .low', () => {
    const int = (n: number) => ({ low: n, high: 0 })
    expect(neo4jDateToISO({ year: int(2025), month: int(12), day: int(31), hour: int(23), minute: int(59), second: int(58) }))
      .toBe(new Date(2025, 11, 31, 23, 59, 58).toISOString())
  })

  it('anything else is stringified rather than dropped', () => {
    expect(neo4jDateToISO(1700000000000)).toBe('1700000000000')
  })
})

describe('mapUser', () => {
  it('maps snake_case props and defaults active to true (legacy users had no flag)', () => {
    expect(mapUser({ id: 'u1', tenant_id: 't1', email: 'a@b.c', name: 'Ann', role: 'admin', created_at: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ id: 'u1', tenantId: 't1', email: 'a@b.c', name: 'Ann', role: 'admin', active: true, createdAt: '2026-01-01T00:00:00.000Z' })
    expect(mapUser({ id: 'u2', active: false }).active).toBe(false)
    expect(mapUser({ id: 'u3' }).createdAt).toBeNull()
  })
})

describe('mapIncident', () => {
  it('maps fields, mirrors severity as priority and fills relation placeholders', () => {
    const props = { id: 'i1', number: 'INC00000001', tenant_id: 't1', title: 'Down', severity: 'high', status: 'new', major: true, created_at: 'c', updated_at: 'u', custom_x: 42 }
    const m = mapIncident(props)
    expect(m).toMatchObject({ id: 'i1', number: 'INC00000001', tenantId: 't1', severity: 'high', priority: 'high', major: true, status: 'new' })
    expect(m).toMatchObject({ assignee: null, assignedTeam: null, affectedCIs: [], causedByProblem: null, comments: [] })
    // Custom fields are reachable through the hidden props, not leaked as enumerable keys.
    expect(ticketPropsOf(m)).toBe(props)
    expect(Object.keys(m)).not.toContain('custom_x')
  })

  it('optional fields default to null/false/empty rather than undefined', () => {
    const m = mapIncident({ id: 'i2' })
    expect(m).toMatchObject({ number: '', impact: null, urgency: null, major: false, category: null, rootCause: null })
  })
})

describe('mapTeam', () => {
  it('maps fields with nullable defaults and isChangeManager false by default', () => {
    expect(mapTeam({ id: 'tm1', tenant_id: 't1', name: 'Ops' })).toEqual({
      id: 'tm1', tenantId: 't1', name: 'Ops', description: null, type: null, sourcing: null, isChangeManager: false, createdAt: null,
    })
    expect(mapTeam({ id: 'tm2', sourcing: 'external', is_change_manager: true }).isChangeManager).toBe(true)
  })
})

describe('toSnakeCase (re-exported)', () => {
  it('follows the Neo4j property convention', () => {
    expect(toSnakeCase('ipAddress')).toBe('ip_address')
  })
})
