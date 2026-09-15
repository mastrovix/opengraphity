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

// Ondata 5 di «Nulla cablato»: entità e campi vengono dal catalogo del metamodello.
const CATALOG = [
  { entityType: 'incident', label: 'Incident', neo4jLabel: 'Incident', group: 'itsm', fields: [
    { name: 'status', label: 'Status', fieldType: 'enum', enumTypeName: null, enumValues: [], property: 'status', groupable: true, numeric: false, custom: false },
    { name: 'priority', label: 'Priority', fieldType: 'enum', enumTypeName: null, enumValues: [], property: 'severity', groupable: true, numeric: false, custom: false },
    { name: 'severity', label: 'Severity', fieldType: 'enum', enumTypeName: null, enumValues: [], property: 'severity', groupable: true, numeric: false, custom: false },
  ] },
  { entityType: 'change', label: 'Change', neo4jLabel: 'Change', group: 'itsm', fields: [
    { name: 'type', label: 'Type', fieldType: 'enum', enumTypeName: 'change_type', enumValues: [], property: 'change_type', groupable: true, numeric: false, custom: false },
    { name: 'aggregate_risk_score', label: 'Risk', fieldType: 'number', enumTypeName: null, enumValues: [], property: 'aggregate_risk_score', groupable: false, numeric: true, custom: false },
  ] },
  { entityType: 'firewall', label: 'Firewall', neo4jLabel: 'Firewall', group: 'cmdb', fields: [
    { name: 'zona', label: 'Zona', fieldType: 'enum', enumTypeName: 'zona', enumValues: [], property: 'zona', groupable: true, numeric: false, custom: true },
    { name: 'ramGb', label: 'RAM', fieldType: 'number', enumTypeName: null, enumValues: [], property: 'ram_gb', groupable: false, numeric: true, custom: true },
  ] },
  { entityType: 'certificate', label: 'Certificate', neo4jLabel: 'Certificate', group: 'cmdb', fields: [] },
]
vi.mock('../../../lib/widgetCatalog.js', () => ({ widgetCatalog: vi.fn(async () => CATALOG) }))

const { validateWidgetConfig: validateWith, customWidgetResolvers } = await import('../customWidget.js')
const validateWidgetConfig = (cfg: Parameters<typeof validateWith>[0]) => validateWith(cfg, CATALOG as never)
const { getSession } = await import('@opengraphity/neo4j')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') } as never

function code(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return ((e as GraphQLError).extensions?.code as string) ?? 'THROWN' }
}

describe('validateWidgetConfig (C-23, ondata 5 di «Nulla cablato»)', () => {
  it('un tipo di CI e un campo del cliente sono accettati, perché sono nel catalogo', () => {
    expect(code(() => validateWidgetConfig({ entityType: 'firewall', metric: 'count_by_field', groupByField: 'zona', filterField: 'zona' }))).toBeNull()
    expect(code(() => validateWidgetConfig({ entityType: 'firewall', metric: 'count_by_field', groupByField: 'zona_x', filterField: null }))).toBe('BAD_USER_INPUT')
  })

  it.each(['avg_field', 'sum_field'])('%s only on numeric catalog fields', (metric) => {
    expect(code(() => validateWidgetConfig({ entityType: 'firewall', metric, groupByField: 'ramGb', filterField: null }))).toBeNull()
    expect(code(() => validateWidgetConfig({ entityType: 'change', metric, groupByField: 'aggregate_risk_score', filterField: null }))).toBeNull()
    // categorical field → refused up front (avg(zona) would be null → previously rendered as 0)
    const err = (() => { try { validateWidgetConfig({ entityType: 'firewall', metric, groupByField: 'zona', filterField: null }); return null } catch (e) { return e as GraphQLError } })()
    expect(err?.extensions?.code).toBe('BAD_USER_INPUT')
    expect(err?.message).toContain('is not numeric')
    expect(err?.message).toContain('ramGb')
    expect(code(() => validateWidgetConfig({ entityType: 'incident', metric, groupByField: 'severity', filterField: null }))).toBe('BAD_USER_INPUT')
    expect(code(() => validateWidgetConfig({ entityType: 'firewall', metric, groupByField: null, filterField: null }))).toBe('BAD_USER_INPUT')
  })

  it('a numeric field is not a grouping or filter field', () => {
    expect(code(() => validateWidgetConfig({ entityType: 'firewall', metric: 'count_by_field', groupByField: 'ramGb', filterField: null }))).toBe('BAD_USER_INPUT')
    expect(code(() => validateWidgetConfig({ entityType: 'firewall', metric: 'count', groupByField: null, filterField: 'ramGb' }))).toBe('BAD_USER_INPUT')
  })

  it('unknown entity / metric', () => {
    expect(code(() => validateWidgetConfig({ entityType: 'apikey', metric: 'count', groupByField: null, filterField: null }))).toBe('BAD_USER_INPUT')
    expect(code(() => validateWidgetConfig({ entityType: 'incident', metric: 'raw', groupByField: null, filterField: null }))).toBe('BAD_USER_INPUT')
  })
})

describe('widget sugli incident (giro nel browser del 14 set 2026)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('raggruppare per priority legge n.severity, dove la priorità è salvata', async () => {
    const run = vi.fn().mockResolvedValue({ records: [{ get: (k: string) => ({ label: 'medium', value: 3 } as Record<string, unknown>)[k] }] })
    vi.mocked(getSession).mockReturnValue({ run, executeRead: vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })), close: vi.fn() } as never)
    const out = await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'incident', metric: 'count_by_field', groupByField: 'priority' }, ctx) as { series: Array<{ label: string }> }
    expect(String(run.mock.calls[0]![0])).toContain('n.severity AS label')
    expect(out.series[0]!.label).toBe('medium')
  })

  it('environment non è un campo degli incident', () => {
    expect(code(() => validateWidgetConfig({ entityType: 'incident', metric: 'count_by_field', groupByField: 'environment', filterField: null }))).toBe('BAD_USER_INPUT')
  })

  it('change per tipo legge n.change_type, dove il tipo è salvato', async () => {
    const run = vi.fn().mockResolvedValue({ records: [{ get: (k: string) => ({ label: 'normal', value: 2 } as Record<string, unknown>)[k] }] })
    vi.mocked(getSession).mockReturnValue({ run, executeRead: vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })), close: vi.fn() } as never)
    await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'change', metric: 'count_by_field', groupByField: 'type' }, ctx)
    expect(String(run.mock.calls[0]![0])).toContain('MATCH (n:Change)')
    expect(String(run.mock.calls[0]![0])).toContain('n.change_type AS label')
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
    try { await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'firewall', metric: 'avg_field', groupByField: 'ramGb' }, ctx) }
    catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GraphQLError)
    expect((thrown as GraphQLError).extensions?.code).toBe('NO_DATA')
    expect((thrown as GraphQLError).message).toContain('avg(ramGb)')
  })

  it('avg with data → rounded value, query uses the whitelisted field', async () => {
    const s = sessionReturning([{ value: 3.14159 }])
    const out = await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'firewall', metric: 'avg_field', groupByField: 'ramGb' }, ctx)
    expect(out.value).toBe(3.14)
    expect(s.run.mock.calls[0]![0]).toContain('MATCH (n:Firewall)')
    expect(s.run.mock.calls[0]![0]).toContain('RETURN avg(n.ram_gb) AS value')
  })

  it('count converts Neo4j Integer', async () => {
    sessionReturning([{ value: { toNumber: () => 12 } }])
    const out = await customWidgetResolvers.Query.widgetDataPreview(null, { entityType: 'incident', metric: 'count' }, ctx)
    expect(out.value).toBe(12)
  })
})
