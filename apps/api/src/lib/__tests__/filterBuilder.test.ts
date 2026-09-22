/**
 * The advanced-filter WHERE builder shared by every list page.
 *
 * Why these behaviours matter: this function turns a user's saved filter into
 * Cypher. Two ways it can hurt a user silently:
 *  - a rule that is DROPPED (unknown field, unknown operator, corrupt JSON)
 *    widens the result set, and the user reads "all tickets matching X" while
 *    looking at every ticket;
 *  - a user-supplied string that reaches the query text instead of a parameter
 *    is an injection.
 * So the contracts pinned here are: every value travels as a parameter, every
 * unknown input is refused loudly, and AND/OR grouping follows the documented
 * "logic is the connector to the NEXT rule" rule. The list operators have
 * their own file (filterBuilderList.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { buildAdvancedWhere, FIELD_NAME_RE } from '../filterBuilder.js'

type Rule = { field: string; operator: string; value?: unknown; value2?: string; logic?: 'AND' | 'OR' }
const spec = (...rules: Rule[]) =>
  JSON.stringify({ rules: rules.map((r) => ({ logic: 'AND', value: null, ...r })) })

const fields = new Set(['title', 'status', 'createdAt', 'priority', 'type', 'assignedTeam'])

describe('input that must not be silently ignored', () => {
  it('corrupt JSON fails the query instead of returning the full unfiltered list', () => {
    expect(() => buildAdvancedWhere('{not json', {}, fields)).toThrow(/Invalid filters JSON/)
  })

  it('an empty rule set is "no filter", not an error', () => {
    expect(buildAdvancedWhere(JSON.stringify({ rules: [] }), {}, fields)).toBe('')
    expect(buildAdvancedWhere(JSON.stringify({}), {}, fields)).toBe('')
  })

  it('a field name that is not an identifier is refused before it can reach the query text', () => {
    // The whitelist is the injection guard; the regex refuses anything that
    // could close the property access and append Cypher.
    expect(() => buildAdvancedWhere(spec({ field: 'title) OR 1=1 //', operator: 'equals', value: 'x' }), {}, fields))
      .toThrow(/Invalid filter field name/)
    expect(FIELD_NAME_RE.test('_x')).toBe(false)
  })

  it('a well-formed field outside the entity whitelist is refused', () => {
    expect(() => buildAdvancedWhere(spec({ field: 'secret', operator: 'equals', value: 'x' }), {}, fields))
      .toThrow(/Filter field not allowed for this entity: secret/)
  })

  it('an unknown operator is refused rather than dropped', () => {
    expect(() => buildAdvancedWhere(spec({ field: 'title', operator: 'sounds_like', value: 'x' }), {}, fields))
      .toThrow(/Unknown filter operator: "sounds_like"/)
  })
})

describe('scalar operators: values travel as parameters', () => {
  const one = (operator: string, value: unknown = 'v', value2?: string) => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(spec({ field: 'title', operator, value, value2 }), params, fields)
    return { where, params }
  }

  it.each([
    ['contains',    'toLower(n.title) CONTAINS toLower($af_0)'],
    ['starts_with', 'toLower(n.title) STARTS WITH toLower($af_0)'],
    ['ends_with',   'toLower(n.title) ENDS WITH toLower($af_0)'],
    ['after',       'datetime(n.title) > datetime($af_0)'],
    ['before',      'datetime(n.title) < datetime($af_0)'],
    ['in',          'n.title IN $af_0'],
  ])('%s → %s, with the value in $af_0', (operator, expected) => {
    const { where, params } = one(operator, "O'Brien")
    expect(where).toBe(expected)
    // The value never appears in the query text: that is the injection contract.
    expect(where).not.toContain("O'Brien")
    expect(params['af_0']).toBe("O'Brien")
  })

  it('text comparisons are case-insensitive on both sides', () => {
    expect(one('contains').where).toMatch(/toLower\(n\.title\).*toLower\(\$af_0\)/)
  })

  it('between binds both ends and is inclusive', () => {
    const { where, params } = one('between', '2026-01-01', '2026-01-31')
    expect(where).toBe('datetime(n.title) >= datetime($af_0) AND datetime(n.title) <= datetime($af_0_2)')
    expect(params).toEqual({ af_0: '2026-01-01', af_0_2: '2026-01-31' })
  })

  it('"empty" treats a missing property and an empty string alike', () => {
    expect(one('is_empty').where).toBe("(n.title IS NULL OR n.title = '')")
    expect(one('is_not_empty').where).toBe("(n.title IS NOT NULL AND n.title <> '')")
  })

  it.each([
    ['today',        'date(n.title) = date()'],
    ['last_7_days',  "datetime(n.title) > datetime() - duration('P7D')"],
    ['last_30_days', "datetime(n.title) > datetime() - duration('P30D')"],
  ])('relative date %s needs no parameter', (operator, expected) => {
    const { where, params } = one(operator)
    expect(where).toBe(expected)
    expect(params).toEqual({})
  })

  it('camelCase fields map to their snake_case property on the node', () => {
    const where = buildAdvancedWhere(spec({ field: 'createdAt', operator: 'today' }), {}, fields)
    expect(where).toBe('date(n.created_at) = date()')
  })

  it('a field stored under another property is filtered on that property (Incident.priority → severity)', () => {
    // Filtering on n.priority would match nothing: the property does not exist.
    const where = buildAdvancedWhere(spec({ field: 'priority', operator: 'equals', value: 'high' }), {}, fields, 'i', {}, 'Incident')
    expect(where).toBe('i.severity = $af_0')
  })

  it('the node alias is honoured', () => {
    expect(buildAdvancedWhere(spec({ field: 'status', operator: 'equals', value: 'open' }), {}, fields, 'w'))
      .toBe('w.status = $af_0')
  })

  it('parameters of different rules do not collide', () => {
    const params: Record<string, unknown> = { t: 'tenant-1' }
    buildAdvancedWhere(spec(
      { field: 'title', operator: 'equals', value: 'a' },
      { field: 'status', operator: 'equals', value: 'b' },
    ), params, fields)
    // The caller's own parameters (the tenant scope) are left untouched.
    expect(params).toEqual({ t: 'tenant-1', af_0: 'a', af_1: 'b' })
  })
})

describe('AND / OR grouping', () => {
  it('logic is the connector to the NEXT rule: OR chains are parenthesised, AND separates groups', () => {
    const where = buildAdvancedWhere(spec(
      { field: 'status', operator: 'equals', value: 'open',   logic: 'OR' },
      { field: 'status', operator: 'equals', value: 'new',    logic: 'AND' },
      { field: 'title',  operator: 'contains', value: 'db' },
    ), {}, fields)
    // Without the parentheses, AND would bind tighter than OR and "open OR (new AND db)"
    // would come back: tickets that are open but have nothing to do with "db".
    expect(where).toBe('(n.status = $af_0 OR n.status = $af_1) AND toLower(n.title) CONTAINS toLower($af_2)')
  })

  it('an OR on the last rule has nothing to connect to and closes the group', () => {
    const where = buildAdvancedWhere(spec(
      { field: 'status', operator: 'equals', value: 'a', logic: 'OR' },
      { field: 'status', operator: 'equals', value: 'b', logic: 'OR' },
    ), {}, fields)
    expect(where).toBe('(n.status = $af_0 OR n.status = $af_1)')
  })

  it('a missing logic defaults to AND', () => {
    const json = JSON.stringify({ rules: [
      { field: 'status', operator: 'equals', value: 'a' },
      { field: 'title', operator: 'equals', value: 'b' },
    ] })
    expect(buildAdvancedWhere(json, {}, fields)).toBe('n.status = $af_0 AND n.title = $af_1')
  })
})

describe('relation fields become EXISTS subqueries', () => {
  const rel = { assignedTeam: { relType: 'ASSIGNED_TO_TEAM', targetLabel: 'Team', searchProp: 'name' } }

  it('equals matches the target property exactly, bound as a parameter', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(spec({ field: 'assignedTeam', operator: 'equals', value: 'Ops' }), params, fields, 'n', rel)
    expect(where).toBe('EXISTS { MATCH (n)-[:ASSIGNED_TO_TEAM]->(_af_t0:Team) WHERE _af_t0.name = $af_0 }')
    expect(params['af_0']).toBe('Ops')
  })

  it('contains is case-insensitive: the parameter is lower-cased once, the property per row', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(spec({ field: 'assignedTeam', operator: 'contains', value: 'OPS' }), params, fields, 'n', rel)
    expect(where).toContain('toLower(_af_t0.name) CONTAINS $af_0')
    expect(params['af_0']).toBe('ops')
  })

  it('is_not_empty asks for at least one related node, with no parameter', () => {
    const params: Record<string, unknown> = {}
    expect(buildAdvancedWhere(spec({ field: 'assignedTeam', operator: 'is_not_empty' }), params, fields, 'n', rel))
      .toBe('EXISTS { MATCH (n)-[:ASSIGNED_TO_TEAM]->(:Team) }')
    expect(params).toEqual({})
  })

  it('equals with no value is refused: an empty match would otherwise be dropped', () => {
    expect(() => buildAdvancedWhere(spec({ field: 'assignedTeam', operator: 'equals', value: '' }), {}, fields, 'n', rel))
      .toThrow(/not supported on relation field assignedTeam/)
  })

  it('an empty relProps object adds no pattern on the relationship', () => {
    const where = buildAdvancedWhere(
      spec({ field: 'assignedTeam', operator: 'is_empty' }), {}, fields, 'n',
      { assignedTeam: { ...rel.assignedTeam, relProps: {} } },
    )
    expect(where).toBe('NOT EXISTS { MATCH (n)-[:ASSIGNED_TO_TEAM]->(:Team) }')
  })

  it('a relationship property key that is not an identifier is refused (keys go into the query text)', () => {
    expect(() => buildAdvancedWhere(
      spec({ field: 'assignedTeam', operator: 'is_empty' }), {}, fields, 'n',
      { assignedTeam: { ...rel.assignedTeam, relProps: { 'bad key': 'x' } } },
    )).toThrow(/Invalid relationship property name/)
  })
})
