/**
 * EVERY COLUMN SORTS (26 Sep 2026, the owner: «le colonne dovrebbero essere
 * sempre tutte ordinabili»): the customer's fields and the SLA too.
 *
 * What a user loses if this regresses: a customer's field column that does not
 * sort; a field name written into the query text; the SLA column sorted in an
 * order that is not urgency.
 */
import { describe, it, expect } from 'vitest'
import { customFieldOrderBy, slaOrderExpr } from '../sortField.js'

describe('customFieldOrderBy', () => {
  it('a customer\'s field sorts through a parameter, never in the text', () => {
    const params: Record<string, unknown> = {}
    expect(customFieldOrderBy('i', 'cf:costCenter', 'desc', params, ['costCenter'], 'incidents(sortField)')).toBe('i[$sortCustomField] DESC')
    expect(params['sortCustomField']).toBe('costCenter')
  })

  it('not a customer\'s field: null, the product\'s list decides', () => {
    expect(customFieldOrderBy('i', 'title', 'asc', {}, ['costCenter'], 'x')).toBeNull()
  })

  it('a field the customer did not define is refused, naming the ones there are', () => {
    expect(() => customFieldOrderBy('i', 'cf:x) DETACH DELETE i', 'asc', {}, ['costCenter'], 'incidents(sortField)'))
      .toThrow(/not a field of this ticket type. Custom fields: costCenter/)
  })
})

describe('slaOrderExpr', () => {
  it('one key, urgency first: breached, running by deadline, met, none', () => {
    const e = slaOrderExpr('i')
    expect(e).toContain("(i)-[:HAS_SLA]->(x:SLAStatus)")
    expect(e).toMatch(/breached THEN '0'.*resolve_met THEN '2' ELSE '1' \+ coalesce\(.*resolve_deadline/)
    expect(e).toContain("IS NULL THEN '3'")
  })
})
