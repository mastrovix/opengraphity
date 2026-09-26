/**
 * «SEGNALA A OPENGRAFO» (26 Sep 2026).
 *
 * What a user loses if this regresses: a customer's name, a service map's
 * name or a title leaving the organization; a report sent twice, or with no
 * note; the platform reporting to itself; a report dropped without a word;
 * the customer never hearing that OpenGrafo read it, or closed it — or
 * hearing it twice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ q: string; params: Record<string, unknown> }>,
  problem: null as Record<string, unknown> | null,
  verifications: [] as Array<Record<string, unknown>>,
  closed: [] as Array<Record<string, unknown>>,
  failed: [] as Array<{ id: string; failedReason?: string }>,
  written: [] as unknown[],
  writeResult: { scritta: true, proposal: { id: 'prop-1' } } as unknown,
  comments: [] as Array<Record<string, unknown>>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => {}, executeWrite: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) }),
  runQueryOne: async (_s: unknown, q: string, params: Record<string, unknown>) => {
    fake.queries.push({ q, params })
    return q.includes('p.from_proposal_id') ? fake.problem : null
  },
  runQuery: async (_s: unknown, q: string, params: Record<string, unknown>) => {
    fake.queries.push({ q, params })
    if (q.includes("area: 'operations', status: 'accepted'")) return fake.verifications
    if (q.includes('report_closed_told_at IS NULL')) return fake.closed
    return []
  },
}))
vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => l }
  return { logger: l }
})
vi.mock('../proposals.js', () => ({ scriviProposta: vi.fn(async (p: unknown) => { fake.written.push(p); return fake.writeResult }) }))
vi.mock('../queueRegistry.js', () => ({ isTenantQueueBase: (q: string) => q === 'sla-jobs' }))
vi.mock('../bullmq.js', () => ({ getTenantQueue: () => ({ getJobs: async () => fake.failed }) }))
vi.mock('../systemText.js', () => ({ systemText: async (t: string, key: string, params: Record<string, string>) => `${t}|${key}|${JSON.stringify(params)}` }))
vi.mock('../ticketComments.js', () => ({ writeTicketComment: async (_tx: unknown, c: Record<string, unknown>) => { fake.comments.push(c); return null } }))

const R = await import('../openGrafoReports.js')

const onOpenGrafo = (over: Record<string, unknown> = {}) => ({
  number: 'PRB00000801', onOpenGrafo: true, reportedAt: null,
  kind: 'proposal.operationsFailedJobsNotHeld', cause: 'queue:sla-jobs',
  params: JSON.stringify({ queue: 'sla-jobs', count: '4', map: 'Billing — ACME', cause: 'queue:sla-jobs' }), ...over,
})

beforeEach(() => {
  fake.queries = []; fake.problem = onOpenGrafo(); fake.verifications = []; fake.closed = []
  fake.failed = []; fake.written = []; fake.comments = []
  fake.writeResult = { scritta: true, proposal: { id: 'prop-1' } }
})

describe('reportState', () => {
  it('a Problem on the OpenGrafo CI, not reported yet, can be reported', async () => {
    expect(await R.reportState('acme', 'p1')).toEqual({ canReport: true, reportedAt: null })
  })
  it('not on the OpenGrafo CI, already reported, or in the platform tenant: it cannot', async () => {
    fake.problem = onOpenGrafo({ onOpenGrafo: false })
    expect((await R.reportState('acme', 'p1')).canReport).toBe(false)
    fake.problem = onOpenGrafo({ reportedAt: '2026-09-26T10:00:00Z' })
    expect(await R.reportState('acme', 'p1')).toEqual({ canReport: false, reportedAt: '2026-09-26T10:00:00Z' })
    fake.problem = onOpenGrafo()
    expect(await R.reportState('opengrafo', 'p1')).toEqual({ canReport: false, reportedAt: null })
  })
})

describe('reportDraft — what leaves, and nothing more', () => {
  it('only technical data: the remedy, its cause, the technical params — never a name', async () => {
    const d = await R.reportDraft('acme', 'p1')
    expect(d.params).toEqual({ tenant: 'acme', problem: 'PRB00000801', cause: 'queue:sla-jobs' })
    expect(d.data).toEqual({
      tenant: 'acme', problem: 'PRB00000801', origin: 'remedy',
      remedy: 'proposal.operationsFailedJobsNotHeld', cause: 'queue:sla-jobs', queue: 'sla-jobs', count: '4',
    })
    expect(JSON.stringify(d)).not.toContain('Billing')
  })

  it('what the verifications found (numbers only), and the reasons of the failed jobs, scrubbed, the repetitions left out', async () => {
    fake.verifications = [{ action: JSON.stringify({ type: 'queue.retry_failed' }), verification: 'unresolved',
      detail: JSON.stringify({ queue: 'sla-jobs', retried: 1, failedAgain: 1 }), at: '2026-09-26T09:38:45Z' }]
    fake.failed = [
      { id: 'repeat:sla-sweep:1', failedReason: 'Failed to connect to server 10.0.0.7' },
      { id: 'j1', failedReason: 'unknown job "x" (entityId=c0ffee00-1111-2222-3333-444455556666)' },
    ]
    const d = await R.reportDraft('acme', 'p1')
    expect(d.data['verification1']).toBe('queue.retry_failed → unresolved (retried=1 failedAgain=1) 2026-09-26T09:38')
    expect(d.data['error1']).toBeDefined()
    expect(d.data['error1']).not.toContain('c0ffee00')
    expect(d.data['error2']).toBeUndefined()
    // Remedies only: the proposal «a person has to look» carries no action and nothing to verify.
    expect(fake.queries.find((x) => x.q.includes("area: 'operations', status: 'accepted'"))!.q).toContain('p.action IS NOT NULL')
  })

  it('a Problem opened by a person on OpenGrafo: its tenant and number, and the note will say the rest', async () => {
    fake.problem = onOpenGrafo({ kind: null, cause: null, params: null })
    expect((await R.reportDraft('acme', 'p1')).data).toEqual({ tenant: 'acme', problem: 'PRB00000801', origin: 'person' })
  })

  it('not on the OpenGrafo CI, or the platform itself: refused', async () => {
    fake.problem = onOpenGrafo({ onOpenGrafo: false })
    await expect(R.reportDraft('acme', 'p1')).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.openGrafoReport.notOnOpenGrafo' } } })
    await expect(R.reportDraft('opengrafo', 'p1')).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.openGrafoReport.platformTenant' } } })
  })
})

describe('reportToOpenGrafo', () => {
  it('a proposal to READ in the platform tenant, with the data, the note and where it comes from; the Problem is marked', async () => {
    const out = await R.reportToOpenGrafo('acme', 'p1', '  Retries keep failing since Monday  ', new Date('2026-09-26T12:00:00Z'))
    expect(out).toEqual({ proposalId: 'prop-1', reportedAt: '2026-09-26T12:00:00.000Z' })
    expect(fake.written[0]).toMatchObject({
      tenantId: 'opengrafo', area: 'platform', kind: 'proposal.platformCustomerReport', action: null,
      scope: 'report:acme:p1', reportNote: 'Retries keep failing since Monday',
      reportSource: { tenantId: 'acme', problemId: 'p1', problemNumber: 'PRB00000801' },
      evidence: { n: 1, extra: expect.objectContaining({ queue: 'sla-jobs' }) },
    })
    const mark = fake.queries.find((x) => x.q.includes('SET p.opengrafo_reported_at'))!
    expect(mark.params).toMatchObject({ tenantId: 'acme', problemId: 'p1', proposalId: 'prop-1' })
  })

  it('no note, a note too long, or a second press: refused, nothing written', async () => {
    await expect(R.reportToOpenGrafo('acme', 'p1', '   ')).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.openGrafoReport.noteRequired' } } })
    await expect(R.reportToOpenGrafo('acme', 'p1', 'x'.repeat(R.MAX_NOTE + 1))).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.openGrafoReport.noteTooLong' } } })
    fake.problem = onOpenGrafo({ reportedAt: '2026-09-26T10:00:00Z' })
    await expect(R.reportToOpenGrafo('acme', 'p1', 'again')).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.openGrafoReport.alreadyReported' } } })
    expect(fake.written).toEqual([])
  })

  it('a report the platform side did not write is said, not taken for sent', async () => {
    fake.writeResult = { scritta: false, motivo: 'gia_presente' }
    await expect(R.reportToOpenGrafo('acme', 'p1', 'note')).rejects.toThrow(/was not written on the platform side \(gia_presente\)/)
    expect(fake.queries.some((x) => x.q.includes('SET p.opengrafo_reported_at'))).toBe(false)
  })
})

describe('the way back', () => {
  it('a comment on the customer\'s Problem, in the customer\'s language, signed OpenGrafo', async () => {
    await R.tellTheReporter({ tenantId: 'acme', problemId: 'p1' }, 'problem_opened', { platformProblem: 'PRB00000009' })
    expect(fake.comments).toEqual([expect.objectContaining({
      entityType: 'problem', entityId: 'p1', tenantId: 'acme', authorLabel: 'OpenGrafo', isInternal: false,
      text: 'acme|openGrafoReport.problem_opened|{"platformProblem":"PRB00000009"}',
    })])
  })

  it('OpenGrafo\'s problem closed: the reporter is told once, and the proposal remembers it', async () => {
    fake.closed = [{ proposalId: 'prop-1', source: JSON.stringify({ tenantId: 'acme', problemId: 'p1' }), number: 'PRB00000009' }]
    expect(await R.reportsClosed()).toBe(1)
    expect(fake.comments[0]).toMatchObject({ tenantId: 'acme', entityId: 'p1', text: 'acme|openGrafoReport.closed|{"platformProblem":"PRB00000009"}' })
    expect(fake.queries.some((x) => x.q.includes('SET pr.report_closed_told_at'))).toBe(true)
    expect(fake.queries.find((x) => x.q.includes('report_closed_told_at IS NULL'))!.q).toContain("WHERE wi.status <> 'active' OR s.is_open = false")
  })
})
