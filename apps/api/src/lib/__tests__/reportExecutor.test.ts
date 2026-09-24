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
    temporalFields: new Map(),
  }),
}))

// Le etichette dei valori hanno il loro test (reportValueLabels.test.ts): qui
// basta sapere che l'esecutore chiede le sorgenti giuste e usa la risposta.
const labeler = vi.fn((_source: unknown, value: unknown) => value)
const loadReportValueLabeler = vi.fn(async () => labeler)
/**
 * Le etichette delle intestazioni (ondata 6, punto 3): qui si finge la mappa
 * vuota, così questi test restano su quello che verificano — l'esecuzione — e
 * le intestazioni ripiegano sul nome interno, come prima.
 */
vi.mock('../reportFieldLabels.js', () => ({ reportFieldLabels: vi.fn(async () => new Map<string, string>()) }))
vi.mock('../ciLabelsForTenant.js', () => ({ ciLabelsForTenant: vi.fn(async () => ['Server', 'DatabaseInstance']) }))
vi.mock('../reportValueLabels.js', () => ({
  identityLabeler: (_s: unknown, v: unknown) => v,
  loadReportValueLabeler: (...args: unknown[]) => loadReportValueLabeler(...(args as [])),
}))

const { mapSectionRecords, executeReportSection, etichettaTemporale } = await import('../reportExecutor.js')
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

  // Review of 23 Sep 2026: a section drawn by the customer ran with no time limit, on the shared database.
  it('the section runs with a time limit, and a timeout is the section\'s error with its key', async () => {
    const s = sessionReturning([{ value: int(1) }])
    await executeReportSection(section({ chartType: 'kpi' }), 't1')
    expect(s.executeRead.mock.calls[0]![1]).toEqual({ timeout: 30_000 })

    s.run.mockRejectedValueOnce(Object.assign(new Error('terminated'), { code: 'Neo.ClientError.Transaction.TransactionTimedOut' }))
    const res = await executeReportSection(section({ chartType: 'kpi' }), 't1')
    expect(res.errorKey).toBe('errors.report.sectionTimeout')
    expect(res.error).toMatch(/more than 30 seconds/)
  })

  // Review of 23 Sep 2026: roles are per ticket type; a section rooted at a type the role cannot read read it anyway.
  it('with the viewer\'s permissions, a section on a label their role cannot read is refused and nothing is queried', async () => {
    const s = sessionReturning([{ value: int(3) }])
    const requestsOnly = new Set(['report.read', 'request.read'])
    const res = await executeReportSection(section(), 't1', { permissions: requestsOnly })
    expect(res.error).toBe('Your role cannot read Incident: this section is not available to you')
    expect(res.errorKey).toBe('errors.report.labelNotReadable')
    expect(getSession).not.toHaveBeenCalled()
    expect(s.run).not.toHaveBeenCalled()
  })

  it('a CI label (the tenant\'s own types included) needs cmdb.read', async () => {
    sessionReturning([{ value: int(3) }])
    const ciSection = section({ nodes: [{ ...section().nodes[0]!, entityType: 'Server', neo4jLabel: 'Server', label: 'Server' }] })
    expect((await executeReportSection(ciSection, 't1', { permissions: new Set(['report.read', 'incident.read']) })).errorKey).toBe('errors.report.labelNotReadable')
    // With cmdb.read the permission no longer stops it (here the fake whitelist does, which is not this test's business).
    expect((await executeReportSection(ciSection, 't1', { permissions: new Set(['report.read', 'cmdb.read']) })).errorKey).not.toBe('errors.report.labelNotReadable')
  })

  it('with the permission of the type, the section runs', async () => {
    sessionReturning([{ value: int(3) }])
    expect((await executeReportSection(section(), 't1', { permissions: new Set(['report.read', 'incident.read']) })).error).toBeNull()
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
    // Intestazione col nome interno: la mappa delle etichette qui è vuota di
    // proposito (ondata 6, punto 3), e senza etichetta il ripiego è il nome.
    expect(JSON.parse(res.data)).toEqual({ columns: ['title'], rows: [['DB down']] })
  })

  it('i valori passano dalle etichette: raggruppamento e colonne con la loro sorgente', async () => {
    sessionReturning([{ label: 'critical', value: int(2) }])
    labeler.mockImplementation((source, value) => (source && value === 'critical' ? 'Critica' : value))
    const res = await executeReportSection(section({ chartType: 'bar', groupByField: 'severity' }), 't1')
    expect(res.error).toBeNull()
    expect(JSON.parse(res.data)).toEqual([{ name: 'Critica', value: 2 }])
    expect(loadReportValueLabeler).toHaveBeenCalledWith(expect.anything(), 't1', [{ neo4jLabel: 'Incident', field: 'severity' }], undefined)
    labeler.mockImplementation((_s, v) => v)
  })

  it('unsupported chartType surfaces as the section error', async () => {
    const s = sessionReturning([])
    const res = await executeReportSection(section({ chartType: 'gauge' }), 't1')
    expect(res.error).toContain('unsupported chartType "gauge"')
    expect(s.run).not.toHaveBeenCalled()
  })
})

/**
 * L'ASSE DI UNA SERIE NON DICE «[object Object]» (19 set 2026).
 *
 * Una data di Neo4j arriva come oggetto temporale; dopo la serializzazione
 * JSON perde il prototipo, e `String(...)` dava «[object Object]». È quello
 * che il proprietario ha visto sull'asse chiedendo gli incident degli ultimi
 * sei mesi — ed era così su OGNI serie, da sempre.
 */
describe('etichettaTemporale', () => {
  it('un testo resta il testo', () => {
    expect(etichettaTemporale('2026-04-01')).toBe('2026-04-01')
  })

  it('una data che ha perso il prototipo si scrive come data', () => {
    expect(etichettaTemporale({ year: 2026, month: 4, day: 1 })).toBe('2026-04-01')
  })

  it('i numeri «lossless» del driver si leggono', () => {
    expect(etichettaTemporale({ year: { low: 2026, high: 0 }, month: { low: 12, high: 0 }, day: { low: 31, high: 0 } }))
      .toBe('2026-12-31')
  })

  it('un oggetto che non è una data non diventa MAI «[object Object]»', () => {
    expect(etichettaTemporale({ qualcosa: 1 })).toBe('{"qualcosa":1}')
  })

  it('niente resta vuoto', () => {
    expect(etichettaTemporale(null)).toBe('')
  })
})
