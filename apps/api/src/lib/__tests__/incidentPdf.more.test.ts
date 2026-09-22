/**
 * loadIncidentDossier — what goes into the incident audit PDF.
 *
 * The dossier is handed to auditors as the record of what happened. The
 * incident-specific part (SLA, watchers, severity colour) is read here: if the
 * SLA or watcher queries were not scoped to the tenant, a dossier could show
 * another customer's people; if a missing SLA became "met", the PDF would
 * certify a compliance that was never measured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  common: null as unknown,
  sla: null as unknown,
  watchers: [] as unknown[],
  one: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  many: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  vocab: vi.fn(async () => ({ values: ['P1'], labels: {}, colors: { P1: 'red' } })),
  loadCommon: vi.fn(),
}))

vi.mock('@opengraphity/neo4j', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opengraphity/neo4j')>()),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { h.one.push({ cypher, params }); return h.sla }),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { h.many.push({ cypher, params }); return h.watchers }),
}))
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: h.vocab }))
vi.mock('../pdf/ticketDossier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdf/ticketDossier.js')>()),
  loadTicketDossier: h.loadCommon,
}))

const { loadIncidentDossier, buildIncidentPdf } = await import('../incidentPdf.js')

function common(props: Record<string, unknown>) {
  return {
    props,
    assignee: { name: 'Mario', email: 'mario@acme.it' },
    team: { name: 'Ops' },
    affectedCIs: [],
    workflowHistory: [],
    comments: [{ author: 'Anna', type: null, createdAt: '2026-09-01T10:00:00Z', text: 'Looking' }],
    attachments: [],
    customFields: [{ label: 'Site', value: 'Milan' }],
  }
}

beforeEach(() => {
  h.one.length = 0; h.many.length = 0; h.sla = null; h.watchers = []
  h.vocab.mockClear(); h.loadCommon.mockReset()
})

describe('loadIncidentDossier', () => {
  it('maps a full incident, its SLA, watchers and the Dictionary colour of its severity', async () => {
    h.loadCommon.mockResolvedValue(common({
      id: 'inc-1', number: 'INC7', title: 'Down', description: 'd', severity: 'P1', status: 'new', category: 'net',
      created_at: 'c', updated_at: 'u', resolved_at: 'r', root_cause: 'rc',
    }))
    h.sla = { sProps: { response_deadline: 'rd', resolve_deadline: null, response_met: true, resolve_met: 0, breached: undefined } }
    h.watchers = [{ name: 'Anna', email: 'anna@acme.it' }, { name: null, email: null }]

    const d = await loadIncidentDossier({} as never, 'inc-1', 't1')

    expect(d.incident).toEqual({
      id: 'inc-1', number: 'INC7', title: 'Down', description: 'd', severity: 'P1', severityColor: 'red', status: 'new',
      category: 'net', createdAt: 'c', updatedAt: 'u', resolvedAt: 'r', rootCause: 'rc',
    })
    // Severity carries a value of the `priority` vocabulary: that is where its colour lives.
    expect(h.vocab).toHaveBeenCalledWith('t1', 'priority')
    expect(d.slaStatus).toEqual({ responseDeadline: 'rd', resolveDeadline: null, responseMet: true, resolveMet: false, breached: false })
    expect(d.watchers).toEqual([{ name: 'Anna', email: 'anna@acme.it' }, { name: '', email: '' }])
    // The comment kind is a problem notion: the incident dossier drops it.
    expect(d.comments).toEqual([{ author: 'Anna', createdAt: '2026-09-01T10:00:00Z', text: 'Looking' }])
    expect(d.customFields).toEqual([{ label: 'Site', value: 'Milan' }])
    expect(h.loadCommon).toHaveBeenCalledWith({}, expect.objectContaining({ label: 'Incident', ciRelation: 'AFFECTED_BY' }), 'inc-1', 't1')
  })

  it('scopes the SLA and watcher queries to the tenant', async () => {
    h.loadCommon.mockResolvedValue(common({ id: 'inc-1' }))
    await loadIncidentDossier({} as never, 'inc-1', 't1')
    for (const q of [...h.one, ...h.many]) {
      expect(q.params).toEqual({ id: 'inc-1', tenantId: 't1' })
      expect(q.cypher).toContain('tenant_id: $tenantId')
    }
    expect(h.one).toHaveLength(1)
    expect(h.many).toHaveLength(1)
  })

  it('a bare incident has no SLA (not a "met" one), no colour and empty texts', async () => {
    h.loadCommon.mockResolvedValue(common({ id: 'inc-2' }))
    const d = await loadIncidentDossier({} as never, 'inc-2', 't1')
    expect(d.slaStatus).toBeNull()
    expect(d.incident).toMatchObject({ number: '', title: '', severity: '', severityColor: null, status: '', description: null, rootCause: null })
    // No severity → no Dictionary read at all.
    expect(h.vocab).not.toHaveBeenCalled()
  })

  it('a severity the Dictionary gives no colour stays without one (not a default grey)', async () => {
    h.loadCommon.mockResolvedValue(common({ id: 'inc-3', severity: 'P9' }))
    const d = await loadIncidentDossier({} as never, 'inc-3', 't1')
    expect(d.incident.severityColor).toBeNull()
  })
})

describe('buildIncidentPdf with an SLA that was met', () => {
  it('renders a PDF (the green SLA badge path)', async () => {
    h.loadCommon.mockResolvedValue(common({ id: 'inc-4', severity: 'P1', status: 'new' }))
    h.sla = { sProps: { breached: false, response_met: true, resolve_met: true } }
    const d = await loadIncidentDossier({} as never, 'inc-4', 't1')
    const pdf = await buildIncidentPdf(d, {
      locale: { language: 'en', timeZone: 'UTC' }, brand: { displayName: 'OpenGrafo', logoPng: null },
      generatedAt: '2026-09-22T10:00:00.000Z', generatedBy: 'tester@example.com', tenantId: 't1',
    })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
