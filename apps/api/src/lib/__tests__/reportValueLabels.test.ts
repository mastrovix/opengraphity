import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/schema-generator', () => ({ toPascalCase: (s: string) => s.replace(/(^|_)(\w)/g, (_m, _u, c: string) => c.toUpperCase()) }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const languageFor = vi.fn(async () => 'it')
vi.mock('../tenantLanguage.js', () => ({ languageFor: (t: string) => languageFor(t) }))
const getWorkflowSteps = vi.fn(async () => [
  { name: 'in_progress', label: 'In lavorazione', labels: [] },
  { name: 'new', label: null, labels: [] },
])
vi.mock('../workflowHelpers.js', () => ({ getWorkflowSteps: (...a: unknown[]) => getWorkflowSteps(...(a as [])) }))

const { loadReportValueLabeler, identityLabeler } = await import('../reportValueLabels.js')

const rec = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] })
const FIELDS = [
  { typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'severity', vocabulary: 'severity' },
  { typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'status', vocabulary: 'status_incident' },
  { typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'title', vocabulary: null },
  { typeName: '__base__', scope: 'base', neo4jLabel: '__base__', field: 'environment', vocabulary: 'environment' },
  { typeName: 'database', scope: 'base', neo4jLabel: 'Database', field: 'instanceType', vocabulary: 'instance_type' },
]
const VOCABULARIES = [
  { name: 'severity', tenant: 'system', labels: JSON.stringify({ critical: { it: 'Critica', en: 'Critical' } }) },
  { name: 'environment', tenant: 'system', labels: JSON.stringify({ production: { it: 'Produzione', en: 'Production' } }) },
  { name: 'environment', tenant: 't1', labels: JSON.stringify({ production: { it: 'Prod (nostra)' } }) },
]

function session() {
  const run = vi.fn(async (query: string) => ({
    records: (query.includes('CITypeDefinition') ? FIELDS : VOCABULARIES).map(rec),
  }))
  return { run, executeRead: vi.fn((fn: (tx: { run: typeof run }) => unknown) => fn({ run })) }
}

beforeEach(() => vi.clearAllMocks())

describe('loadReportValueLabeler', () => {
  /** Secondo giro UI del 15 set 2026 · V-20: il widget in italiano diceva «Medium, Critical» (lingua del cliente). */
  it('V-20: con la lingua di chi guarda le etichette seguono quella, non la lingua del cliente', async () => {
    const label = await loadReportValueLabeler(session() as never, 't1', [{ neo4jLabel: 'Incident', field: 'severity' }], 'en')
    expect(label({ neo4jLabel: 'Incident', field: 'severity' }, 'critical')).toBe('Critical')
    expect(languageFor).not.toHaveBeenCalled()
  })

  it('un vocabolario si legge con l\'etichetta nella lingua del tenant', async () => {
    const label = await loadReportValueLabeler(session() as never, 't1', [{ neo4jLabel: 'Incident', field: 'severity' }])
    expect(label({ neo4jLabel: 'Incident', field: 'severity' }, 'critical')).toBe('Critica')
    // un valore che il vocabolario non conosce resta com'è
    expect(label({ neo4jLabel: 'Incident', field: 'severity' }, 'apocalittica')).toBe('apocalittica')
  })

  it('lo status di un ticket si legge con l\'etichetta del passo, e un passo senza etichetta resta il nome', async () => {
    const label = await loadReportValueLabeler(session() as never, 't1', [{ neo4jLabel: 'Incident', field: 'status' }])
    expect(getWorkflowSteps).toHaveBeenCalledWith(expect.anything(), 't1', 'incident')
    expect(label({ neo4jLabel: 'Incident', field: 'status' }, 'in_progress')).toBe('In lavorazione')
    expect(label({ neo4jLabel: 'Incident', field: 'status' }, 'new')).toBe('new')
  })

  it('i campi di sistema dei CI vengono dal tipo base, e il vocabolario del tenant vince', async () => {
    const label = await loadReportValueLabeler(session() as never, 't1', [{ neo4jLabel: 'Server', field: 'environment' }])
    expect(label({ neo4jLabel: 'Server', field: 'environment' }, 'production')).toBe('Prod (nostra)')
  })

  it('testo libero, numeri e sorgenti assenti restano grezzi; nessuna sorgente → nessuna query', async () => {
    const s = session()
    expect(await loadReportValueLabeler(s as never, 't1', [null])).toBe(identityLabeler)
    expect(s.run).not.toHaveBeenCalled()
    const label = await loadReportValueLabeler(session() as never, 't1', [{ neo4jLabel: 'Incident', field: 'title' }, { neo4jLabel: 'Incident', field: 'severity' }])
    expect(label({ neo4jLabel: 'Incident', field: 'title' }, 'critical')).toBe('critical')
    expect(label({ neo4jLabel: 'Incident', field: 'severity' }, 3)).toBe(3)
    expect(label(null, 'critical')).toBe('critical')
  })

  it('il nome del campo in camelCase trova la proprietà in snake_case', async () => {
    const label = await loadReportValueLabeler(session() as never, 't1', [{ neo4jLabel: 'Database', field: 'instance_type' }])
    expect(label({ neo4jLabel: 'Database', field: 'instanceType' }, 'x')).toBe('x')
    expect(languageFor).toHaveBeenCalledWith('t1')
  })
})
