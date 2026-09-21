import { describe, it, expect } from 'vitest'
import { ticketDiff } from '../ticketUpdated.js'

describe('ticketDiff (AU-1)', () => {
  it('i campi cambiati e i valori di prima; updated_at non conta', () => {
    expect(ticketDiff(
      { title: 'A', severity: 'low', impact: 'low', updated_at: '1', tags: ['x'] },
      { title: 'A', severity: 'high', impact: 'medium', updated_at: '2', tags: ['x'], root_cause: 'disk' },
    )).toEqual({ changed: ['impact', 'root_cause', 'severity'], previous: { impact: 'low', root_cause: null, severity: 'low' } })
  })
  it('nessun cambiamento → nessun campo', () => {
    expect(ticketDiff({ a: 1, updated_at: '1' }, { a: 1, updated_at: '2' }).changed).toEqual([])
  })
})
