/**
 * Change PDF: loading the dossier from the graph.
 *
 * Why these behaviours matter:
 *  - The "Change Audit Report" is handed to auditors. Every read must be
 *    anchored to the tenant, and every field must map from the graph exactly
 *    (a task without an id is "no task", not an empty row; a missing risk
 *    score is "no score", not 0).
 *  - The RISK badge colour is the customer's colour for the customer's band
 *    (C-17): the band is computed from the tenant's thresholds and the colour
 *    read from the tenant's `risk_band` vocabulary. With no score there is no
 *    band lookup at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  toNumber: (v: unknown) => Number(v ?? 0),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const loadTicketDossier = vi.fn()
vi.mock('../pdf/ticketDossier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdf/ticketDossier.js')>()),
  loadTicketDossier: (...a: unknown[]) => loadTicketDossier(...a),
}))
const riskBandOf = vi.fn()
vi.mock('../riskBands.js', () => ({ riskBandOf: (...a: unknown[]) => riskBandOf(...a) }))
const loadVocabularyEntries = vi.fn()
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: (...a: unknown[]) => loadVocabularyEntries(...a) }))

const { loadChangeDossier, buildChangePdf } = await import('../changePdf.js')

const session = {} as never
const common = (props: Record<string, unknown>) => ({
  props, workflowHistory: [{ stepName: 'draft' }], attachments: [{ filename: 'a.pdf' }], customFields: [{ label: 'X', value: 'y' }],
})

beforeEach(() => {
  vi.clearAllMocks()
  runQueryOne.mockResolvedValue(null)
  runQuery.mockResolvedValue([])
})

describe('loadChangeDossier', () => {
  it('maps the change, people, per-CI tasks and audit trail, all tenant-scoped', async () => {
    loadTicketDossier.mockResolvedValue(common({
      id: 'chg-1', code: 'CHG1', title: 'Upgrade', why: 'EOL', what: 'v3',
      aggregate_risk_score: '72', approval_route: 'cab', approval_status: 'approved', approval_at: '2026-09-01',
      created_at: '2026-08-01', updated_at: '2026-09-02',
    }))
    runQueryOne.mockResolvedValue({
      reqUser: { id: 'u1', name: 'Mario', email: 'm@x' }, ownerUser: { name: 'no id' }, currentStep: 'deployment',
    })
    runQuery
      .mockResolvedValueOnce([
        {
          ciProps: { id: 'ci-1', name: 'payment-api', environment: 'production' }, nodeLabels: ['ConfigurationItem', 'Application'],
          ciPhase: 'deployment', riskScore: '40',
          ownerTask: { id: 'a1', code: 'AT-1', status: 'completed', score: '30', completed_at: '2026-08-02' },
          supportTask: { code: 'AT-2' }, // no id: not a task
          deployPlan: { id: 'd1' },
          validation: { id: 'v1', code: 'VT-1', status: 'completed', result: 'pass', tested_at: '2026-08-05' },
          deployment: { id: 'dt1', code: 'DT-1', status: 'in_progress', deployed_at: null },
          review: { id: 'r1', code: 'RV-1', status: 'done', result: 'ok', reviewed_at: '2026-08-09' },
        },
        {
          ciProps: { id: 'ci-2' }, nodeLabels: ['Server'], ciPhase: null, riskScore: null,
          ownerTask: null, supportTask: null, deployPlan: null, validation: null, deployment: null, review: null,
        },
        { ciProps: {}, nodeLabels: ['Database'], ciPhase: null, riskScore: null, ownerTask: null, supportTask: null, deployPlan: null, validation: null, deployment: null, review: null },
      ])
      .mockResolvedValueOnce([
        { aProps: { timestamp: '2026-08-01', action: 'change_created', detail: 'd' }, uProps: { name: 'Mario', email: 'm@x' } },
        { aProps: {}, uProps: { email: 'only@mail' } },
        { aProps: { action: 'x' }, uProps: {} },
        { aProps: { action: 'y' }, uProps: null },
      ])
    riskBandOf.mockResolvedValue('high')
    loadVocabularyEntries.mockResolvedValue({ values: ['low', 'high'], labels: {}, colors: { high: 'danger' } })

    const d = await loadChangeDossier(session, 'chg-1', 't1')

    // The shared loader is asked for a soft-deletable Change.
    expect(loadTicketDossier).toHaveBeenCalledWith(session, { label: 'Change', entityType: 'change', softDelete: true }, 'chg-1', 't1')
    for (const call of [...runQueryOne.mock.calls, ...runQuery.mock.calls]) {
      expect(call[2]).toMatchObject({ id: 'chg-1', tenantId: 't1' })
    }
    expect(riskBandOf).toHaveBeenCalledWith('t1', 72)
    expect(loadVocabularyEntries).toHaveBeenCalledWith('t1', 'risk_band')
    expect(d.riskBandColor).toBe('danger')

    expect(d.change).toEqual({
      id: 'chg-1', code: 'CHG1', title: 'Upgrade', why: 'EOL', what: 'v3', aggregateRiskScore: 72,
      approvalRoute: 'cab', approvalStatus: 'approved', approvalAt: '2026-09-01', createdAt: '2026-08-01', updatedAt: '2026-09-02',
    })
    expect(d.phase).toBe('deployment')
    expect(d.requester).toEqual({ name: 'Mario', email: 'm@x' })
    expect(d.changeOwner).toBeNull()

    const [ci1, ci2, ci3] = d.affectedCIs
    expect(ci1).toMatchObject({ name: 'payment-api', type: 'application', environment: 'production', riskScore: 40, ciPhase: 'deployment' })
    expect(ci1!.assessmentOwner).toEqual({ code: 'AT-1', status: 'completed', score: 30, result: null, completedAt: '2026-08-02' })
    expect(ci1!.assessmentSupport).toBeNull()
    expect(ci1!.deployPlan).toEqual({ code: '', status: '', score: null, result: null, completedAt: null })
    // Each task kind reads ITS completion date.
    expect(ci1!.validation).toMatchObject({ result: 'pass', completedAt: '2026-08-05' })
    expect(ci1!.deployment).toMatchObject({ completedAt: null })
    expect(ci1!.review).toMatchObject({ result: 'ok', completedAt: '2026-08-09' })
    // A CI without a name falls back to its id, then to empty.
    expect(ci2).toMatchObject({ name: 'ci-2', environment: null, riskScore: null, ciPhase: null, assessmentOwner: null, review: null })
    expect(ci3!.name).toBe('')

    expect(d.auditTrail).toEqual([
      { timestamp: '2026-08-01', action: 'change_created', detail: 'd', actor: 'Mario' },
      { timestamp: null, action: '', detail: null, actor: 'only@mail' },
      { timestamp: null, action: 'x', detail: null, actor: null },
      { timestamp: null, action: 'y', detail: null, actor: null },
    ])
    expect(d.workflowHistory).toEqual([{ stepName: 'draft' }])
    expect(d.attachments).toEqual([{ filename: 'a.pdf' }])
    expect(d.customFields).toEqual([{ label: 'X', value: 'y' }])
  })

  it('without a risk score there is no band and no colour lookup; missing fields become null/empty', async () => {
    loadTicketDossier.mockResolvedValue(common({ id: 'chg-2' }))
    const d = await loadChangeDossier(session, 'chg-2', 't1')
    expect(riskBandOf).not.toHaveBeenCalled()
    expect(loadVocabularyEntries).not.toHaveBeenCalled()
    expect(d.riskBandColor).toBeNull()
    expect(d.change).toMatchObject({ code: '', title: '', why: null, aggregateRiskScore: null, approvalRoute: null })
    expect(d.phase).toBeNull()
    expect(d.requester).toBeNull()
    expect(d.affectedCIs).toEqual([])
  })

  it('a band the customer gave no colour renders neutral (null colour), not a guessed one', async () => {
    loadTicketDossier.mockResolvedValue(common({ id: 'chg-3', aggregate_risk_score: 0 }))
    riskBandOf.mockResolvedValue('low')
    loadVocabularyEntries.mockResolvedValue({ values: ['low'], labels: {}, colors: {} })
    const d = await loadChangeDossier(session, 'chg-3', 't1')
    // Score 0 is a real score: the band IS looked up.
    expect(riskBandOf).toHaveBeenCalledWith('t1', 0)
    expect(d.riskBandColor).toBeNull()
    expect(d.change.aggregateRiskScore).toBe(0)
  })

  it('the loaded dossier renders to a PDF, including the approval-status-only badge', async () => {
    loadTicketDossier.mockResolvedValue(common({ id: 'chg-4', title: 'T', approval_status: 'rejected' }))
    const d = await loadChangeDossier(session, 'chg-4', 't1')
    const buf = await buildChangePdf({ ...d, workflowHistory: [], attachments: [], customFields: [] }, {
      locale: { language: 'en', timeZone: 'UTC' },
      brand: { displayName: 'OpenGrafo', logoPng: null },
      generatedAt: '2026-09-22T10:00:00.000Z', generatedBy: 'a@b.c', tenantId: 't1',
    })
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
