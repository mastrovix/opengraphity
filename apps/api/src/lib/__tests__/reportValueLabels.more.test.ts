/**
 * Report value labels — the edge paths the main suite does not reach.
 *
 * Every report execution (page, dashboard widget, scheduled send, PDF, Excel)
 * goes through this labeler. What must hold for a reader:
 *  - the TENANT's vocabulary wins over the shipped one whatever order the graph
 *    returns them in (otherwise the customer's renamed labels flicker back);
 *  - an unreadable `value_labels` leaves raw values and says so in the log,
 *    instead of breaking the report;
 *  - a status column reads the step label in the viewer's language;
 *  - columns nobody can label cost no extra query and come back untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/schema-generator', () => ({ toPascalCase: (s: string) => s.replace(/(^|_)(\w)/g, (_m, _u, c: string) => c.toUpperCase()) }))
const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const languageFor = vi.fn(async (_tenantId: string) => 'it')
vi.mock('../tenantLanguage.js', () => ({ languageFor: (t: string) => languageFor(t) }))
const getWorkflowSteps = vi.fn()
vi.mock('../workflowHelpers.js', () => ({ getWorkflowSteps: (...a: unknown[]) => getWorkflowSteps(...a) }))

const { loadReportValueLabeler, identityLabeler } = await import('../reportValueLabels.js')

const rec = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] })

function session(data: { fields?: unknown[]; forms?: unknown[]; vocabularies?: unknown[] }) {
  const run = vi.fn(async (query: string, _p?: unknown) => ({
    records: ((query.includes('CITypeDefinition') ? data.fields
      : query.includes('FormField') ? data.forms
      : data.vocabularies) ?? []).map((r) => rec(r as Record<string, unknown>)),
  }))
  return { run, executeRead: vi.fn((fn: (tx: { run: typeof run }) => unknown) => fn({ run })) }
}

beforeEach(() => vi.clearAllMocks())

describe('loadReportValueLabeler — edge paths', () => {
  it('the tenant vocabulary wins even when the graph returns it BEFORE the shipped one', async () => {
    const s = session({
      fields: [{ typeName: 'server', scope: 'base', neo4jLabel: 'Server', field: 'environment', vocabulary: 'environment' }],
      vocabularies: [
        { name: 'environment', tenant: 't1', labels: JSON.stringify({ production: { it: 'Prod (nostra)' } }) },
        { name: 'environment', tenant: 'system', labels: JSON.stringify({ production: { it: 'Produzione' } }) },
      ],
    })
    const label = await loadReportValueLabeler(s as never, 't1', [{ neo4jLabel: 'Server', field: 'environment' }])
    expect(label({ neo4jLabel: 'Server', field: 'environment' }, 'production')).toBe('Prod (nostra)')
  })

  it('unreadable value_labels: values stay raw and the log names the vocabulary', async () => {
    const s = session({
      fields: [{ typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'severity', vocabulary: 'severity' }],
      vocabularies: [{ name: 'severity', tenant: 't1', labels: '{not json' }],
    })
    const label = await loadReportValueLabeler(s as never, 't1', [{ neo4jLabel: 'Incident', field: 'severity' }])
    expect(label({ neo4jLabel: 'Incident', field: 'severity' }, 'critical')).toBe('critical')
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', vocabulary: 'severity', error: expect.stringContaining('not valid JSON') }), expect.any(String))
  })

  it('a vocabulary the graph does not return leaves the value raw', async () => {
    const s = session({
      fields: [{ typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'severity', vocabulary: 'severity' }],
      vocabularies: [],
    })
    const label = await loadReportValueLabeler(s as never, 't1', [{ neo4jLabel: 'Incident', field: 'severity' }])
    expect(label({ neo4jLabel: 'Incident', field: 'severity' }, 'critical')).toBe('critical')
  })

  it('status reads the step label in the viewer\'s language, falling back to the step label; no vocabulary query', async () => {
    getWorkflowSteps.mockResolvedValue([
      { name: 'in_progress', label: 'In lavorazione', labels: [{ language: 'en', label: 'In progress' }] },
      { name: 'new', label: 'Nuovo', labels: [{ language: 'it', label: 'Nuovo' }] },
    ])
    const s = session({ fields: [{ typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'status', vocabulary: null }] })
    const src = { neo4jLabel: 'Incident', field: 'status' }
    const label = await loadReportValueLabeler(s as never, 't1', [src, src], 'en')
    expect(label(src, 'in_progress')).toBe('In progress')
    expect(label(src, 'new')).toBe('Nuovo')
    expect(label(src, '')).toBe('')
    // Two identical sources → the workflow is read once.
    expect(getWorkflowSteps).toHaveBeenCalledTimes(1)
    // Only steps: the vocabulary query is not run at all.
    expect(s.run.mock.calls.some(([q]) => String(q).includes('e.value_labels'))).toBe(false)
  })

  it('a type without neo4j_label is matched by the PascalCase of its name', async () => {
    const s = session({
      fields: [{ typeName: 'load_balancer', scope: 'base', neo4jLabel: null, field: 'tier', vocabulary: 'tier' }],
      vocabularies: [{ name: 'tier', tenant: 't1', labels: JSON.stringify({ gold: { it: 'Oro' } }) }],
    })
    const label = await loadReportValueLabeler(s as never, 't1', [{ neo4jLabel: 'LoadBalancer', field: 'tier' }])
    expect(label({ neo4jLabel: 'LoadBalancer', field: 'tier' }, 'gold')).toBe('Oro')
  })

  it('columns nobody can label → the identity labeler, and the language is never looked up', async () => {
    const s = session({
      fields: [{ typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'title', vocabulary: null }],
      forms: [],
    })
    const label = await loadReportValueLabeler(s as never, 't1', [
      { neo4jLabel: 'Incident', field: 'title' },
      { neo4jLabel: 'Ghost', field: 'nothing' },
      { neo4jLabel: 'ServiceRequest', field: 'not_a_form_field' },
    ])
    expect(label).toBe(identityLabeler)
    expect(identityLabeler({ neo4jLabel: 'Incident', field: 'title' }, 'x')).toBe('x')
    expect(languageFor).not.toHaveBeenCalled()
  })

  it('an ITIL entity does not inherit CI system fields from __base__', async () => {
    // `status` on Incident must be the workflow step, never the CI status vocabulary.
    const s = session({
      fields: [
        { typeName: 'incident', scope: 'itil', neo4jLabel: 'Incident', field: 'title', vocabulary: null },
        { typeName: '__base__', scope: 'base', neo4jLabel: '__base__', field: 'environment', vocabulary: 'environment' },
      ],
    })
    const label = await loadReportValueLabeler(s as never, 't1', [{ neo4jLabel: 'Incident', field: 'environment' }])
    expect(label).toBe(identityLabeler)
  })
})
