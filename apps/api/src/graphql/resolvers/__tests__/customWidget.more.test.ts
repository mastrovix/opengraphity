/**
 * Custom dashboard widgets: storing them, reading them, and computing their
 * numbers.
 *
 * Why these behaviours matter to a user:
 *  - every read and write checks the dashboard first (read access to see,
 *    ownership to change): without it anyone in the tenant could see or wreck
 *    someone else's private dashboard;
 *  - every query carries the tenant: a widget must never count another
 *    customer's tickets;
 *  - a widget that cannot run must never be stored — it would sit on the
 *    dashboard showing an error forever;
 *  - a filter value is compared in the TYPE of the field: the client always
 *    sends text, and `n.vpn = 'true'` never matches a boolean, so a widget
 *    counted zero for ever and presented that zero as data;
 *  - an aggregate with no data is an error, never a fabricated 0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../reportAccess.js', () => ({
  assertDashboardAccess: vi.fn().mockResolvedValue({}),
  assertDashboardOwnerByWidget: vi.fn().mockResolvedValue('d1'),
  resolveDashboardIdForWidget: vi.fn().mockResolvedValue('d1'),
}))

const CATALOG = [
  { entityType: 'service_request', label: 'Request', neo4jLabel: 'ServiceRequest', group: 'itsm', fields: [
    { name: 'status', label: 'Status', fieldType: 'enum', enumTypeName: null, enumValues: [], property: 'status', groupable: true, numeric: false, custom: false },
    { name: 'vpn', label: 'VPN', fieldType: 'boolean', enumTypeName: null, enumValues: [], property: 'serve_vpn', groupable: true, numeric: false, custom: true },
    { name: 'seats', label: 'Seats', fieldType: 'number', enumTypeName: null, enumValues: [], property: 'seats', groupable: true, numeric: true, custom: true },
    { name: 'cost', label: 'Cost', fieldType: 'number', enumTypeName: null, enumValues: [], property: 'cost', groupable: false, numeric: true, custom: true },
  ] },
  { entityType: 'certificate', label: 'Certificate', neo4jLabel: 'Certificate', group: 'cmdb', fields: [
    { name: 'issuer', label: 'Issuer', fieldType: 'string', enumTypeName: null, enumValues: [], property: 'issuer', groupable: true, numeric: false, custom: false },
  ] },
]
vi.mock('../../../lib/widgetCatalog.js', () => ({ widgetCatalog: vi.fn(async () => CATALOG) }))

const { customWidgetResolvers, dashboardCustomWidgets, validateWidgetConfig, widgetFilterValue } = await import('../customWidget.js')
const { getSession } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { assertDashboardAccess, assertDashboardOwnerByWidget, resolveDashboardIdForWidget } = await import('../reportAccess.js')
const { widgetCatalog } = await import('../../../lib/widgetCatalog.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') } as never
const { Query, Mutation } = customWidgetResolvers

type Row = Record<string, unknown>
interface FakeSession {
  run: ReturnType<typeof vi.fn>
  executeRead: ReturnType<typeof vi.fn>
  executeWrite: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

/** One session whose `run` answers the queued result sets in order. */
function session(...results: Row[][]): FakeSession {
  const run = vi.fn()
  for (const rows of results) run.mockResolvedValueOnce({ records: rows.map((r) => ({ get: (k: string) => r[k] })) })
  run.mockResolvedValue({ records: [] })
  const s: FakeSession = {
    run,
    executeRead: vi.fn((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    executeWrite: vi.fn((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

const stored = { id: 'w1', title: 'Open', widget_type: 'kpi', entity_type: 'service_request', metric: 'count', position: 2.0, dashboard_id: 'd1' }

async function failure(promise: Promise<unknown>): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  return err as GraphQLError
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertDashboardAccess).mockResolvedValue({} as never)
  vi.mocked(assertDashboardOwnerByWidget).mockResolvedValue('d1' as never)
  vi.mocked(resolveDashboardIdForWidget).mockResolvedValue('d1' as never)
})

describe('widgetFilterValue — the filter in the type of the field', () => {
  it('booleans: "true"/"false" in any case and with spaces; anything else stays as sent', () => {
    expect(widgetFilterValue(' TRUE ', 'boolean')).toBe(true)
    expect(widgetFilterValue('false', 'boolean')).toBe(false)
    expect(widgetFilterValue('yes', 'boolean')).toBe('yes')
  })

  it('numbers: a numeric text becomes a number, a non-numeric one stays as sent', () => {
    expect(widgetFilterValue(' 42 ', 'number')).toBe(42)
    expect(widgetFilterValue('many', 'number')).toBe('many')
  })

  it('other types and null pass through untouched', () => {
    expect(widgetFilterValue('open', 'enum')).toBe('open')
    expect(widgetFilterValue(null, 'boolean')).toBeNull()
    expect(widgetFilterValue(undefined, 'number')).toBeUndefined()
  })
})

describe('validateWidgetConfig — the returned accessors', () => {
  it('property() refuses a field that was not validated: nothing unchecked may reach the Cypher', () => {
    const v = validateWidgetConfig({ entityType: 'certificate', metric: 'count', groupByField: null, filterField: null }, CATALOG as never)
    expect(v.neo4jLabel).toBe('Certificate')
    expect(v.property('issuer')).toBe('issuer')
    expect(() => v.property('evil) DETACH DELETE n //')).toThrow(/not validated/)
    // an unknown field compares as text
    expect(v.fieldType('nope')).toBe('string')
    expect(v.fieldType('issuer')).toBe('string')
  })

  it('an aggregate on an entity without numeric fields says there are none', () => {
    try {
      validateWidgetConfig({ entityType: 'certificate', metric: 'sum_field', groupByField: 'issuer', filterField: null }, CATALOG as never)
      expect.unreachable()
    } catch (e) {
      expect((e as GraphQLError).extensions['i18n']).toMatchObject({ key: 'errors.widget.noNumericField' })
      expect((e as GraphQLError).message).toContain('no field')
    }
  })

  it('a filter field that is not groupable is refused', () => {
    expect(() => validateWidgetConfig({ entityType: 'service_request', metric: 'count', groupByField: null, filterField: 'cost' }, CATALOG as never)).toThrow(/filter field not allowed/)
  })
})

describe('customWidgets / DashboardConfig.customWidgets — reading', () => {
  it('checks read access to the dashboard, reads within the tenant, maps with defaults', async () => {
    const s = session([{ w: stored }])
    const out = await Query.customWidgets(null, { dashboardId: 'd1' }, ctx)
    expect(assertDashboardAccess).toHaveBeenCalledWith(s, 'd1', ctx, 'read')
    expect(s.run.mock.calls[0]![1]).toEqual({ dashId: 'd1', tenantId: 't1' })
    // widgets stored before size/color existed get the defaults the UI expects
    expect(out).toEqual([{ id: 'w1', title: 'Open', widgetType: 'kpi', entityType: 'service_request', metric: 'count',
      groupByField: null, filterField: null, filterValue: null, timeRange: null, size: 'medium', color: '#0EA5E9', position: 2, dashboardId: 'd1' }])
    expect(s.close).toHaveBeenCalled()
  })

  it('no access → nothing is read, and the session is still closed', async () => {
    const s = session()
    vi.mocked(assertDashboardAccess).mockRejectedValueOnce(new GraphQLError('forbidden', { extensions: { code: 'FORBIDDEN' } }))
    await expect(Query.customWidgets(null, { dashboardId: 'd2' }, ctx)).rejects.toThrow('forbidden')
    expect(s.run).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalled()
  })

  it('the field resolver reads the parent dashboard in the tenant, in position order', async () => {
    const s = session([{ w: { ...stored, size: 'large', color: '#111111', position: null } }])
    const out = await dashboardCustomWidgets({ id: 'd1' }, null, ctx)
    expect(s.run.mock.calls[0]![0]).toContain('ORDER BY w.position ASC')
    expect(s.run.mock.calls[0]![1]).toEqual({ id: 'd1', tenantId: 't1' })
    expect(out[0]).toMatchObject({ size: 'large', color: '#111111', position: 0 })
    expect(s.close).toHaveBeenCalled()
  })

  it('widgetCatalog is the tenant catalog', async () => {
    expect(await Query.widgetCatalog(null, null, ctx)).toBe(CATALOG)
    expect(widgetCatalog).toHaveBeenCalledWith('t1')
  })
})

describe('widgetData — the numbers of a stored widget', () => {
  it('resolves the dashboard of the widget, checks read access, then runs its configuration', async () => {
    const s = session([{ w: stored }], [{ value: 5 }])
    const out = await Query.widgetData(null, { widgetId: 'w1' }, ctx)
    expect(resolveDashboardIdForWidget).toHaveBeenCalledWith(s, 'w1', 'customWidget', 't1')
    expect(assertDashboardAccess).toHaveBeenCalledWith(s, 'd1', ctx, 'read')
    expect(s.run.mock.calls[1]![0]).toContain('MATCH (n:ServiceRequest) WHERE n.tenant_id = $tenantId RETURN count(n)')
    expect(out).toEqual({ value: 5, label: 'Open', series: [] })
  })

  it('a widget that is not there is NOT_FOUND', async () => {
    const s = session([])
    const err = await failure(Query.widgetData(null, { widgetId: 'w-x' }, ctx))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(s.close).toHaveBeenCalled()
  })
})

describe('widgetDataPreview — metrics, time range and filters', () => {
  it('a time range limits to recent items; "all" and unknown ranges do not', async () => {
    const s = session([{ value: 1 }], [{ value: 1 }], [{ value: 1 }])
    const before = Date.now()
    await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count', timeRange: '7d' }, ctx)
    const params = s.run.mock.calls[0]![1] as { since: string }
    expect(s.run.mock.calls[0]![0]).toContain('n.created_at >= $since')
    const ageH = (before - Date.parse(params.since)) / 3_600_000
    expect(ageH).toBeGreaterThan(24 * 7 - 1)
    expect(ageH).toBeLessThan(24 * 7 + 1)
    await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count', timeRange: 'all' }, ctx)
    await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count', timeRange: '5y' }, ctx)
    expect(s.run.mock.calls[1]![0]).not.toContain('$since')
    expect(s.run.mock.calls[2]![0]).not.toContain('$since')
  })

  it('a boolean filter is sent as a boolean on the mapped property (the "always zero" widget)', async () => {
    const s = session([{ value: 3 }])
    const out = await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count', filterField: 'vpn', filterValue: 'true' }, ctx)
    expect(s.run.mock.calls[0]![0]).toContain('n.serve_vpn = $filterValue')
    expect(s.run.mock.calls[0]![1]).toEqual({ tenantId: 't1', filterValue: true })
    expect(out).toEqual({ value: 3, label: 'Preview', series: [] })
  })

  it('a filter field without a value filters nothing', async () => {
    const s = session([{ value: 3 }])
    await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count', filterField: 'vpn', filterValue: null }, ctx)
    expect(s.run.mock.calls[0]![0]).not.toContain('$filterValue')
  })

  it('count_by_field: series with a total; an empty group label reads N/A', async () => {
    session([{ label: 'open', value: 4 }, { label: null, value: { toNumber: () => 2 } }])
    const out = await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count_by_field', groupByField: 'status' }, ctx)
    expect(out).toEqual({ value: 6, label: 'Preview', series: [{ label: 'open', value: 4 }, { label: 'N/A', value: 2 }] })
  })

  it('count_by_field without a grouping field is refused with BAD_USER_INPUT', async () => {
    const s = session()
    const err = await failure(Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count_by_field' }, ctx))
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(s.run).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalled()
  })

  it('sum_field sums the numeric property', async () => {
    const s = session([{ value: 17 }])
    const out = await Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'sum_field', groupByField: 'cost' }, ctx)
    expect(s.run.mock.calls[0]![0]).toContain('RETURN sum(n.cost) AS value')
    expect(out.value).toBe(17)
  })

  it('a non-numeric aggregate result is an error, not NaN on the dashboard', async () => {
    session([{ value: 'abc' }])
    await expect(Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'sum_field', groupByField: 'cost' }, ctx))
      .rejects.toThrow(/non-numeric result \(abc\)/)
  })

  it('a count over no rows at all is NO_DATA, never 0', async () => {
    session([])
    const err = await failure(Query.widgetDataPreview(null, { entityType: 'service_request', metric: 'count' }, ctx))
    expect(err.extensions['code']).toBe('NO_DATA')
  })
})

describe('createCustomWidget', () => {
  const input = { dashboardId: 'd1', title: 'Seats', widgetType: 'kpi', entityType: 'service_request', metric: 'avg_field', groupByField: 'seats' }

  it('an invalid configuration is refused before the dashboard is even opened', async () => {
    await expect(Mutation.createCustomWidget(null, { input: { ...input, metric: 'median' } }, ctx)).rejects.toThrow(/Unsupported metric/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('needs write access to the dashboard', async () => {
    const s = session()
    vi.mocked(assertDashboardAccess).mockRejectedValueOnce(new Error('not your dashboard'))
    await expect(Mutation.createCustomWidget(null, { input }, ctx)).rejects.toThrow('not your dashboard')
    expect(assertDashboardAccess).toHaveBeenCalledWith(s, 'd1', ctx, 'write')
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalled()
  })

  it('appends after the last widget, in the tenant, with defaults, and audits', async () => {
    const s = session([{ maxPos: 4 }], [])
    const out = await Mutation.createCustomWidget(null, { input }, ctx)
    expect(out).toMatchObject({ title: 'Seats', position: 5, size: 'medium', color: '#0EA5E9', groupByField: 'seats', filterField: null, filterValue: null, timeRange: null, dashboardId: 'd1' })
    const params = s.run.mock.calls[1]![1] as Record<string, unknown>
    expect(params).toMatchObject({ tenantId: 't1', dashId: 'd1', position: 5, userId: 'u1', size: 'medium', color: '#0EA5E9' })
    expect(audit).toHaveBeenCalledWith(ctx, 'customWidget.created', 'CustomWidget', out.id, { title: 'Seats' })
  })

  it('the first widget of a dashboard gets position 0; explicit size and color are kept', async () => {
    session([], [])
    const out = await Mutation.createCustomWidget(null, { input: { ...input, metric: 'count', groupByField: null, filterField: 'status', filterValue: 'open', timeRange: '30d', size: 'large', color: '#222222' } }, ctx)
    expect(out).toMatchObject({ position: 0, size: 'large', color: '#222222', filterField: 'status', filterValue: 'open', timeRange: '30d', groupByField: null })
  })
})

describe('updateCustomWidget', () => {
  it('only the owner of the dashboard changes a widget', async () => {
    const s = session()
    vi.mocked(assertDashboardOwnerByWidget).mockRejectedValueOnce(new Error('only the owner'))
    await expect(Mutation.updateCustomWidget(null, { id: 'w1', input: { title: 'x' } }, ctx)).rejects.toThrow('only the owner')
    expect(assertDashboardOwnerByWidget).toHaveBeenCalledWith(s, 'w1', 'customWidget', ctx)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('sets exactly the sent fields, in the tenant', async () => {
    const s = session([{ w: { ...stored, title: 'New' } }])
    const out = await Mutation.updateCustomWidget(null, { id: 'w1', input: {
      title: 'New', widgetType: 'bar', entityType: 'service_request', metric: 'count_by_field', groupByField: 'status',
      filterField: 'vpn', filterValue: 'true', timeRange: '24h', size: 'small', color: '#333333', position: 0,
    } }, ctx)
    const [cypher, params] = s.run.mock.calls[0]! as [string, Record<string, unknown>]
    for (const part of ['w.title = $title', 'w.widget_type = $widgetType', 'w.entity_type = $entityType', 'w.metric = $metric',
      'w.group_by_field = $gbf', 'w.filter_field = $ff', 'w.filter_value = $fv', 'w.time_range = $timeRange',
      'w.size = $size', 'w.color = $color', 'w.position = $position']) expect(cypher).toContain(part)
    expect(cypher).toContain('DashboardConfig {tenant_id: $tenantId}')
    // position 0 is a value, not "not sent"
    expect(params).toMatchObject({ id: 'w1', tenantId: 't1', position: 0, gbf: 'status', ff: 'vpn', fv: 'true' })
    expect(out.title).toBe('New')
    expect(audit).toHaveBeenCalledWith(ctx, 'customWidget.updated', 'CustomWidget', 'w1')
  })

  it('nulls do not overwrite: only updated_at is set', async () => {
    const s = session([{ w: stored }])
    await Mutation.updateCustomWidget(null, { id: 'w1', input: { title: null, color: null } }, ctx)
    expect(s.run.mock.calls[0]![0]).toMatch(/SET w\.updated_at = \$now\s+RETURN/)
  })

  it('a widget that is not there is NOT_FOUND and is not audited', async () => {
    session([])
    const err = await failure(Mutation.updateCustomWidget(null, { id: 'w-x', input: { title: 'x' } }, ctx))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('deleteCustomWidget', () => {
  it('only the owner deletes; the delete is tenant-scoped and audited', async () => {
    const s = session([])
    expect(await Mutation.deleteCustomWidget(null, { id: 'w1' }, ctx)).toBe(true)
    expect(assertDashboardOwnerByWidget).toHaveBeenCalledWith(s, 'w1', 'customWidget', ctx)
    expect(s.run.mock.calls[0]![1]).toEqual({ id: 'w1', tenantId: 't1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'customWidget.deleted', 'CustomWidget', 'w1')

    vi.mocked(assertDashboardOwnerByWidget).mockRejectedValueOnce(new Error('only the owner'))
    const s2 = session()
    await expect(Mutation.deleteCustomWidget(null, { id: 'w1' }, ctx)).rejects.toThrow('only the owner')
    expect(s2.run).not.toHaveBeenCalled()
    expect(s2.close).toHaveBeenCalled()
  })
})

describe('reorderCustomWidgets', () => {
  it('needs write access; positions follow the given order; returns the reordered list', async () => {
    const s = session([], [{ w: { ...stored, id: 'w2', position: 0 } }, { w: { ...stored, position: 1 } }])
    const out = await Mutation.reorderCustomWidgets(null, { dashboardId: 'd1', widgetIds: ['w2', 'w1'] }, ctx)
    expect(assertDashboardAccess).toHaveBeenCalledWith(s, 'd1', ctx, 'write')
    expect(s.run.mock.calls[0]![1]).toEqual({ items: [{ id: 'w2', position: 0 }, { id: 'w1', position: 1 }], dashId: 'd1', tenantId: 't1' })
    expect(out.map((w) => w.id)).toEqual(['w2', 'w1'])
  })

  it('without write access nothing moves', async () => {
    const s = session()
    vi.mocked(assertDashboardAccess).mockRejectedValueOnce(new Error('read only'))
    await expect(Mutation.reorderCustomWidgets(null, { dashboardId: 'd1', widgetIds: ['w1'] }, ctx)).rejects.toThrow('read only')
    expect(s.executeWrite).not.toHaveBeenCalled()
  })
})
