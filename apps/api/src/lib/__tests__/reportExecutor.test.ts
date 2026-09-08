import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  // Stub of the real helper (D-22): plain numbers and Integer-like objects.
  toNumber: (v: unknown) => (v == null ? 0 : typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('../reportWhitelist.js', () => ({
  getReportWhitelist: vi.fn().mockResolvedValue({
    labels: new Set(['Incident', 'Team']),
    relationshipTypes: new Set(['ASSIGNED_TO_TEAM']),
  }),
}))

const { mapSectionRecords, executeReportSection } = await import('../reportExecutor.js')
const { CHART_TYPES } = await import('../reportQueryBuilder.js')
const { getSession } = await import('@opengraphity/neo4j')
import type { ChartType, ReportSectionDef } from '../reportQueryBuilder.js'

const rec = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] })
const int = (n: number) => ({ toNumber: () => n })

function section(overrides: Partial<ReportSectionDef> = {}): ReportSectionDef {
  return {
    id: 'sec', order: 0, title: 'Titolo', chartType: 'kpi',
    groupByNodeId: null, groupByField: null, metric: 'count', metricField: null, limit: null, sortDir: null,
    nodes: [{ id: 'root', entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 0, positionY: 0, filters: null, selectedFields: [] }],
    edges: [],
    ...overrides,
  }
}

// ── mapSectionRecords: one case per ChartType (C-11) ─────────────────────────

describe('mapSectionRecords — exhaustive over CHART_TYPES', () => {
  const expectations: Record<ChartType, { records: ReturnType<typeof rec>[]; data: unknown; total: number }> = {
    kpi:            { records: [rec({ value: int(42) })], data: { value: 42, label: 'Titolo' }, total: 42 },
    pie:            { records: [rec({ label: 'open', value: int(3) }), rec({ label: null, value: 1 })], data: [{ name: 'open', value: 3 }, { name: '(none)', value: 1 }], total: 2 },
    donut:          { records: [rec({ label: 'a', value: 2 })], data: [{ name: 'a', value: 2 }], total: 1 },
    bar:            { records: [rec({ label: 'a', value: 2 })], data: [{ name: 'a', value: 2 }], total: 1 },
    bar_horizontal: { records: [rec({ label: 'a', value: 2 })], data: [{ name: 'a', value: 2 }], total: 1 },
    top_n:          { records: [rec({ label: 'team-x', value: int(9) })], data: [{ name: 'team-x', value: 9 }], total: 1 },
    line:           { records: [rec({ label: '2026-09-01', value: int(4) })], data: [{ date: '2026-09-01', value: 4 }], total: 1 },
    area:           { records: [rec({ label: '2026-09-01', value: 4 })], data: [{ date: '2026-09-01', value: 4 }], total: 1 },
    table:          { records: [rec({ c0: 'DB down', c1: null })], data: { columns: ['Incident_title', 'Incident_status'], rows: [['DB down', null]] }, total: 1 },
  }

  it('the table above covers every chart type (compile-time via Record<ChartType>, runtime here)', () => {
    expect(Object.keys(expectations).sort()).toEqual([...CHART_TYPES].sort())
  })

  it.each(CHART_TYPES)('%s', (chartType) => {
    const exp = expectations[chartType]
    const columns = chartType === 'table' ? [{ alias: 'c0', name: 'Incident_title' }, { alias: 'c1', name: 'Incident_status' }] : []
    expect(mapSectionRecords(chartType, { title: 'Titolo' }, exp.records, columns)).toEqual({ data: exp.data, total: exp.total })
  })

  it('kpi with zero rows is an error, not a fabricated 0', () => {
    expect(() => mapSectionRecords('kpi', { title: 't' }, [], [])).toThrow('KPI query returned no rows')
  })

  it('unknown chart type is rejected (never-check at runtime)', () => {
    expect(() => mapSectionRecords('sparkline' as ChartType, { title: 't' }, [], [])).toThrow('Unhandled chartType')
  })
})

// ── executeReportSection: builder ↔ executor contract end to end ─────────────

describe('executeReportSection', () => {
  beforeEach(() => vi.clearAllMocks())

  function sessionReturning(rows: Array<Record<string, unknown>>) {
    const run = vi.fn().mockResolvedValue({ records: rows.map(rec) })
    const s = {
      run,
      executeRead: vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
      close: vi.fn().mockResolvedValue(undefined),
    }
    vi.mocked(getSession).mockReturnValue(s as never)
    return s
  }

  it('top_n: builder emits label/value and the executor reads them (no more "no field label")', async () => {
    const s = sessionReturning([{ label: 'team-a', value: int(5) }])
    const res = await executeReportSection(section({ chartType: 'top_n', groupByField: 'status', limit: 5 }), 't1')
    expect(res.error).toBeNull()
    expect(JSON.parse(res.data)).toEqual([{ name: 'team-a', value: 5 }])
    const [query] = s.run.mock.calls[0]! as [string]
    expect(query).toContain('AS label, count(n0) AS value')
    expect(query).toContain('LIMIT toInteger($limit)')
  })

  it('table without selected fields: clear validation error, no query executed', async () => {
    const s = sessionReturning([])
    const res = await executeReportSection(section({ chartType: 'table' }), 't1')
    expect(res.error).toContain('a table section needs at least one selected field')
    expect(res.data).toBe('{}')
    expect(s.run).not.toHaveBeenCalled()
  })

  it('table with fields: rows are read through the generated aliases', async () => {
    sessionReturning([{ c0: 'DB down' }])
    const sec = section({ chartType: 'table' })
    sec.nodes[0]!.selectedFields = ['title']
    const res = await executeReportSection(sec, 't1')
    expect(res.error).toBeNull()
    expect(JSON.parse(res.data)).toEqual({ columns: ['Incident_title'], rows: [['DB down']] })
  })

  it('unsupported chartType surfaces as the section error', async () => {
    const s = sessionReturning([])
    const res = await executeReportSection(section({ chartType: 'gauge' }), 't1')
    expect(res.error).toContain('unsupported chartType "gauge"')
    expect(s.run).not.toHaveBeenCalled()
  })
})
