import { describe, it, expect, vi, afterEach } from 'vitest'
import { matchesFilterGroup, applyFilterGroup } from './filterGroup'
import type { FilterGroup, FilterOperator, FilterRule } from '@/components/FilterBuilder'

let seq = 0
function rule(field: string, operator: FilterOperator, value: string | string[] | null = null, extra: Partial<FilterRule> = {}): FilterRule {
  return { id: `r${++seq}`, field, operator, value, logic: 'AND', ...extra }
}
const group = (...rules: FilterRule[]): FilterGroup => ({ rules })

const rows = [
  { id: '1', name: 'Mario Rossi',  email: 'mario@acme.com', role: 'admin',    createdAt: '2026-09-01T10:00:00Z' },
  { id: '2', name: 'Anna Bianchi', email: 'anna@acme.com',  role: 'operator', createdAt: '2026-08-01T10:00:00Z' },
  { id: '3', name: 'Luca Verdi',   email: '',               role: 'viewer',   createdAt: null },
]

afterEach(() => { vi.useRealTimers() })

describe('matchesFilterGroup — operatori testo (case-insensitive)', () => {
  const cases: [FilterOperator, string, boolean][] = [
    ['contains',    'ROSSI', true],
    ['contains',    'nope',  false],
    ['starts_with', 'mario', true],
    ['starts_with', 'rossi', false],
    ['ends_with',   'rossi', true],
    ['ends_with',   'mario', false],
    ['equals',      'Mario Rossi', true],
    ['equals',      'mario rossi', false],   // equals è esatto, non case-insensitive
    ['not_equals',  'Mario Rossi', false],
    ['not_equals',  'x', true],
  ]
  it.each(cases)('%s "%s" → %s', (op, val, expected) => {
    expect(matchesFilterGroup(rows[0]!, group(rule('name', op, val)))).toBe(expected)
  })

  it('is_empty / is_not_empty trattano null e stringa vuota allo stesso modo', () => {
    expect(matchesFilterGroup(rows[2]!, group(rule('email', 'is_empty')))).toBe(true)
    expect(matchesFilterGroup(rows[2]!, group(rule('createdAt', 'is_empty')))).toBe(true)
    expect(matchesFilterGroup(rows[0]!, group(rule('email', 'is_empty')))).toBe(false)
    expect(matchesFilterGroup(rows[0]!, group(rule('email', 'is_not_empty')))).toBe(true)
    expect(matchesFilterGroup(rows[2]!, group(rule('email', 'is_not_empty')))).toBe(false)
  })

  it('un valore non stringa nella regola è trattato come stringa vuota', () => {
    expect(matchesFilterGroup(rows[0]!, group(rule('name', 'contains', null)))).toBe(true)
    expect(matchesFilterGroup(rows[0]!, group(rule('name', 'equals', null)))).toBe(false)
  })
})

describe('matchesFilterGroup — operatori enum (in / not_in)', () => {
  it('in confronta con la lista, not_in è il complemento', () => {
    expect(matchesFilterGroup(rows[0]!, group(rule('role', 'in', ['admin', 'viewer'])))).toBe(true)
    expect(matchesFilterGroup(rows[1]!, group(rule('role', 'in', ['admin', 'viewer'])))).toBe(false)
    expect(matchesFilterGroup(rows[1]!, group(rule('role', 'not_in', ['admin', 'viewer'])))).toBe(true)
    expect(matchesFilterGroup(rows[0]!, group(rule('role', 'not_in', ['admin'])))).toBe(false)
  })

  it('in con valore non-array non matcha mai; not_in matcha sempre', () => {
    expect(matchesFilterGroup(rows[0]!, group(rule('role', 'in', 'admin')))).toBe(false)
    expect(matchesFilterGroup(rows[0]!, group(rule('role', 'not_in', 'admin')))).toBe(true)
  })
})

describe('matchesFilterGroup — operatori data', () => {
  it('after / before confrontano istanti', () => {
    expect(matchesFilterGroup(rows[0]!, group(rule('createdAt', 'after',  '2026-08-15')))).toBe(true)
    expect(matchesFilterGroup(rows[1]!, group(rule('createdAt', 'after',  '2026-08-15')))).toBe(false)
    expect(matchesFilterGroup(rows[1]!, group(rule('createdAt', 'before', '2026-08-15')))).toBe(true)
    expect(matchesFilterGroup(rows[0]!, group(rule('createdAt', 'before', '2026-08-15')))).toBe(false)
  })

  it('between è inclusivo e richiede entrambi gli estremi', () => {
    expect(matchesFilterGroup(rows[0]!, group(rule('createdAt', 'between', '2026-09-01T10:00:00Z', { value2: '2026-09-30' })))).toBe(true)
    expect(matchesFilterGroup(rows[1]!, group(rule('createdAt', 'between', '2026-09-01', { value2: '2026-09-30' })))).toBe(false)
    expect(matchesFilterGroup(rows[0]!, group(rule('createdAt', 'between', '2026-09-01')))).toBe(false)
  })

  it('valori nulli o non parsabili non matchano mai gli operatori data', () => {
    expect(matchesFilterGroup(rows[2]!, group(rule('createdAt', 'after', '2000-01-01')))).toBe(false)
    expect(matchesFilterGroup({ createdAt: 'not-a-date' }, group(rule('createdAt', 'before', '2999-01-01')))).toBe(false)
    expect(matchesFilterGroup(rows[0]!, group(rule('createdAt', 'after', 'garbage')))).toBe(false)
  })

  it('today / last_7_days / last_30_days usano l\'orologio corrente', () => {
    vi.useFakeTimers({ now: new Date('2026-09-08T12:00:00Z') })
    const r = (createdAt: string) => ({ createdAt })
    expect(matchesFilterGroup(r('2026-09-08T03:00:00Z'), group(rule('createdAt', 'today')))).toBe(true)
    expect(matchesFilterGroup(r('2026-09-07T03:00:00Z'), group(rule('createdAt', 'today')))).toBe(false)
    expect(matchesFilterGroup(r('2026-09-03T12:00:00Z'), group(rule('createdAt', 'last_7_days')))).toBe(true)
    expect(matchesFilterGroup(r('2026-08-30T12:00:00Z'), group(rule('createdAt', 'last_7_days')))).toBe(false)
    expect(matchesFilterGroup(r('2026-08-30T12:00:00Z'), group(rule('createdAt', 'last_30_days')))).toBe(true)
    expect(matchesFilterGroup(r('2026-07-30T12:00:00Z'), group(rule('createdAt', 'last_30_days')))).toBe(false)
  })
})

describe('matchesFilterGroup — combinazione AND / OR', () => {
  it('AND tra regole: tutte devono valere', () => {
    const g = group(rule('role', 'equals', 'admin', { logic: 'AND' }), rule('name', 'contains', 'mario'))
    expect(matchesFilterGroup(rows[0]!, g)).toBe(true)
    expect(matchesFilterGroup(rows[1]!, g)).toBe(false)
  })

  it('OR tra regole: ne basta una', () => {
    const g = group(rule('role', 'equals', 'admin', { logic: 'OR' }), rule('role', 'equals', 'operator'))
    expect(applyFilterGroup(rows, g).map((r) => r.id)).toEqual(['1', '2'])
  })

  it('le catene OR sono raggruppate e unite in AND (stessa semantica dell\'API)', () => {
    // (role=admin OR role=operator) AND name contains "anna"
    const g = group(
      rule('role', 'equals', 'admin', { logic: 'OR' }),
      rule('role', 'equals', 'operator', { logic: 'AND' }),
      rule('name', 'contains', 'anna'),
    )
    expect(applyFilterGroup(rows, g).map((r) => r.id)).toEqual(['2'])
  })

  it('il connettore dell\'ultima regola è ignorato', () => {
    const g = group(rule('role', 'equals', 'viewer', { logic: 'OR' }))
    expect(applyFilterGroup(rows, g).map((r) => r.id)).toEqual(['3'])
  })
})

describe('applyFilterGroup', () => {
  it('senza filtro ritorna lo STESSO array (nessuna copia)', () => {
    expect(applyFilterGroup(rows, null)).toBe(rows)
    expect(applyFilterGroup(rows, undefined)).toBe(rows)
    expect(applyFilterGroup(rows, { rules: [] })).toBe(rows)
  })

  it('filtra le righe che non soddisfano il gruppo', () => {
    expect(applyFilterGroup(rows, group(rule('email', 'ends_with', 'acme.com'))).map((r) => r.id)).toEqual(['1', '2'])
  })
})

describe('operatore sconosciuto', () => {
  it('lancia invece di scartare la regola (nessun allargamento silenzioso)', () => {
    const bad = rule('name', 'regex_match' as FilterOperator, 'x')
    expect(() => matchesFilterGroup(rows[0]!, group(bad))).toThrow(/Unknown filter operator: "regex_match"/)
    expect(() => applyFilterGroup(rows, group(bad))).toThrow(/Unknown filter operator/)
  })
})
