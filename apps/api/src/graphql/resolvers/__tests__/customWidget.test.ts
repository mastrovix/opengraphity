import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../reportAccess.js', () => ({
  assertDashboardAccess: vi.fn().mockResolvedValue({}),
  assertDashboardOwnerByWidget: vi.fn().mockResolvedValue('d1'),
  resolveDashboardIdForWidget: vi.fn().mockResolvedValue('d1'),
}))

const { validateWidgetConfig, NUMERIC_FIELDS, customWidgetResolvers } = await import('../customWidget.js')
const { getSession } = await import('@opengraphity/neo4j')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' } as never

function code(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return ((e as GraphQLError).extensions?.code as string) ?? 'THROWN' }
}

describe('validateWidgetConfig (C-23)', () => {
  it('business_application accepts snake_case business_unit and rejects the old camelCase', () => {
    expect(code(() => validateWidgetConfig({ entityType: 'business_application', metric: 'count_by_field', groupByField: 'business_unit', filterField: null }))).toBeNull()
    expect(code(() => validateWidgetConfig({ entityType: 'business_application', metric: 'count_by_field', groupByField: 'businessUnit', filterField: null }))).toBe('BAD_USER_INPUT')
  })

  it.each(['avg_field', 'sum_field'])('%s only on numeric whitelisted fields', (metric) => {
    expect(code(() => validateWidgetConfig({ entityType: 'server', metric, groupByField: 'cpu_cores', filterField: null }))).toBeNull()
    // categorical field → refused up front (avg(status) would be null → previously rendered as 0)
    const err = (() => { try { validateWidgetConfig({ entityType: 'server', metric, groupByField: 'status', filterField: null }); return null } catch (e) { return e as GraphQLError } })()
    expect(err?.extensions?.code).toBe('BAD_USER_INPUT')
    expect(err?.message).toContain('non è numerico')
    expect(err?.message).toContain('cpu_cores')
    expect(code(() => validateWidgetConfig({ entityType: 'incident', metric, groupByField: 'severity', filterField: null }))).toBe('BAD_USER_INPUT')
    expect(code(() => validateWidgetConfig({ entityType: 'server', metric, groupByField: null, filterField: null }))).toBe('BAD_USER_INPUT')
  })

  it('numeric whitelist never overlaps with categorical fields used for grouping', () => {
    for (const fields of Object.values(NUMERIC_FIELDS)) {
      for (const f of fields) expect(['status', 'severity', 'priority', 'category', 'environment', 'type']).not.toContain(f)
    }
  })

  it('unknown entity / metric', () => {
    expect(code(() => validateWidgetConfig({ entityType: 'apikey', metric: 'count', groupByField: null, filterField: null }))).toBe('BAD_USER_INPUT')
    expect(code(() => validateWidgetConfig({ entityType: 'incident', metric: 'raw', groupByField: null, filterField: null }))).toBe('BAD_USER_INPUT')
  })
})

describe('widgetDataPreview — null aggregate is an error, never 0', () => {
  beforeEach(() => vi.clearAllMocks())

  function sessionReturning(rows: Array<Record<string, unknown>>) {
    const run = vi.fn().mockResolvedValue({ records: rows.map(r => ({ get: (k: string) => r[k] })) })
    const s = { run, executeRead: vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })), close: vi.fn() }
    vi.mocked(getSession).mockReturnValue(s as never)
    return s
  }

  it('avg over no matching nodes → NO_DATA error surfaced to the widget', async () => {
    sessionReturning([{ value: null }])
    let thrown: unknown
    try { await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'server', metric: 'avg_field', groupByField: 'ram_gb' }, ctx) }
    catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GraphQLError)
    expect((thrown as GraphQLError).extensions?.code).toBe('NO_DATA')
    expect((thrown as GraphQLError).message).toContain('avg(ram_gb)')
  })

  it('avg with data → rounded value, query uses the whitelisted field', async () => {
    const s = sessionReturning([{ value: 3.14159 }])
    const out = await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'server', metric: 'avg_field', groupByField: 'ram_gb' }, ctx)
    expect(out.value).toBe(3.14)
    expect(s.run.mock.calls[0]![0]).toContain('RETURN avg(n.ram_gb) AS value')
  })

  it('count converts Neo4j Integer', async () => {
    sessionReturning([{ value: { toNumber: () => 12 } }])
    const out = await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'incident', metric: 'count' }, ctx)
    expect(out.value).toBe(12)
  })
})
