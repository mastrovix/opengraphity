/**
 * The shared "ticket dossier": the loading half and the section renderers
 * used by the incident, change and problem audit PDFs.
 *
 * Why these behaviours matter:
 *  - The dossier is an audit document. It must describe the ticket of the
 *    caller's tenant and nothing else: every query is tenant-scoped, and a
 *    ticket that does not exist (or is soft-deleted, where the kind has soft
 *    deletion) is NOT_FOUND rather than an empty report.
 *  - Customer custom fields appear in designer order even when empty: in a
 *    report "not filled in" is information, so empty values become null and
 *    render as a dash instead of vanishing.
 *  - Optional parts (affected CIs, comments) are queried only for the kinds
 *    that have them; a missing author, size or name must not crash the PDF.
 *  - Each section says "none" explicitly when it is empty, instead of a bare
 *    heading that reads like a rendering failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PDFDocument from 'pdfkit'

const neo = vi.hoisted(() => ({ runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => neo)
const customFieldDefs = vi.hoisted(() => vi.fn())
vi.mock('../../ticketCustomFields.js', () => ({ customFieldDefs }))
vi.mock('../../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})

const { registerCITypes } = await import('../../ciTypeFromLabels.js')
const D = await import('../ticketDossier.js')
const { pdfText } = await import('../texts.js')
const { createPdfBuffer } = await import('../common.js')

const LOCALE = { language: 'en', timeZone: 'UTC' } as const
const session = {} as never

/** Answers each dossier query by what it asks for. */
function answer(rows: { ci?: unknown[]; history?: unknown[]; comments?: unknown[]; attachments?: unknown[] }) {
  neo.runQuery.mockImplementation(async (_s: unknown, cypher: string) => {
    if (cypher.includes('labels(ci)')) return rows.ci ?? []
    if (cypher.includes('STEP_HISTORY')) return rows.history ?? []
    if (cypher.includes('HAS_COMMENT')) return rows.comments ?? []
    if (cypher.includes(':Attachment')) return rows.attachments ?? []
    throw new Error(`unexpected query: ${cypher}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  customFieldDefs.mockResolvedValue([])
  registerCITypes('t1', [{ neo4jLabel: 'Server', name: 'server' }])
})

describe('userRef', () => {
  it('is null without a user id, and fills missing name/email with empty strings', () => {
    expect(D.userRef(null)).toBeNull()
    expect(D.userRef({ name: 'Nobody' })).toBeNull()
    expect(D.userRef({ id: 'u1' })).toEqual({ name: '', email: '' })
    expect(D.userRef({ id: 'u1', name: 'Ada', email: 'ada@x' })).toEqual({ name: 'Ada', email: 'ada@x' })
  })
})

describe('loadTicketDossier', () => {
  const fullSpec = { label: 'Problem', entityType: 'problem', ciRelation: 'AFFECTS', comments: { label: 'ProblemComment', authorProp: 'author_id' }, softDelete: true } as const

  it('a ticket that is not in the tenant is NOT_FOUND', async () => {
    neo.runQueryOne.mockResolvedValue(null)
    await expect(D.loadTicketDossier(session, fullSpec, 'p1', 't1'))
      .rejects.toSatisfy((e) => (e as { extensions: { code: string } }).extensions.code === 'NOT_FOUND')
    expect(neo.runQueryOne.mock.calls[0]![2]).toEqual({ id: 'p1', tenantId: 't1' })
  })

  it('excludes soft-deleted tickets only for kinds that soft-delete', async () => {
    neo.runQueryOne.mockResolvedValue({ props: {}, uProps: null, tProps: null })
    answer({})
    await D.loadTicketDossier(session, fullSpec, 'p1', 't1')
    expect(String(neo.runQueryOne.mock.calls[0]![1])).toContain('coalesce(e.deleted, false) = false')

    await D.loadTicketDossier(session, { label: 'Incident', entityType: 'incident' }, 'i1', 't1')
    expect(String(neo.runQueryOne.mock.calls[1]![1])).not.toContain('deleted')
  })

  it('maps every part, with defaults for missing values', async () => {
    neo.runQueryOne.mockResolvedValue({
      props: { id: 'p1', impact: 'high', notes: '', cost: 0 },
      uProps: { id: 'u1', name: 'Ada', email: 'ada@x' },
      tProps: {},
    })
    customFieldDefs.mockResolvedValue([
      { name: 'impact', label: 'Business impact' },
      { name: 'notes', label: 'Notes' },
      { name: 'missing', label: 'Never filled' },
      { name: 'cost', label: 'Cost' },
    ])
    answer({
      ci: [
        { props: { name: 'srv-01', environment: 'production', status: 'active' }, nodeLabels: ['ConfigurationItem', 'Server'] },
        { props: { id: 'ci-2' }, nodeLabels: ['Server'] },
      ],
      history: [
        { eProps: { step_name: 'in_progress', entered_at: 'a', exited_at: 'b', duration_ms: 1500.6, triggered_by: 'u1', trigger_type: 'manual', notes: 'n' } },
        { eProps: {} },
      ],
      comments: [
        { cProps: { type: 'workaround', created_at: 'c', text: 'reboot' }, uProps: { name: 'Ada' } },
        { cProps: {}, uProps: { email: 'bob@x' } },
        { cProps: { text: 'ghost' }, uProps: null },
      ],
      attachments: [
        { filename: 'log.txt', sizeBytes: 2048, uploadedBy: 'Ada', uploadedAt: 'd' },
        { filename: null, sizeBytes: null, uploadedBy: null, uploadedAt: null },
      ],
    })

    const d = await D.loadTicketDossier(session, fullSpec, 'p1', 't1')
    expect(d.assignee).toEqual({ name: 'Ada', email: 'ada@x' })
    // A team node without a name is still a team, shown with an empty name.
    expect(d.team).toEqual({ name: '' })
    expect(d.customFields).toEqual([
      { label: 'Business impact', value: 'high' },
      { label: 'Notes', value: null },
      { label: 'Never filled', value: null },
      // Zero is a value, not "empty".
      { label: 'Cost', value: '0' },
    ])
    expect(d.affectedCIs).toEqual([
      { name: 'srv-01', type: 'server', environment: 'production', status: 'active' },
      { name: 'ci-2', type: 'server', environment: null, status: null },
    ])
    expect(d.workflowHistory).toEqual([
      { stepName: 'in_progress', enteredAt: 'a', exitedAt: 'b', durationMs: 1501, triggeredBy: 'u1', triggerType: 'manual', notes: 'n' },
      { stepName: '', enteredAt: null, exitedAt: null, durationMs: null, triggeredBy: null, triggerType: null, notes: null },
    ])
    expect(d.comments).toEqual([
      { author: 'Ada', type: 'workaround', createdAt: 'c', text: 'reboot' },
      { author: 'bob@x', type: null, createdAt: null, text: '' },
      { author: null, type: null, createdAt: null, text: 'ghost' },
    ])
    expect(d.attachments).toEqual([
      { filename: 'log.txt', sizeBytes: 2048, uploadedBy: 'Ada', uploadedAt: 'd' },
      { filename: '', sizeBytes: 0, uploadedBy: null, uploadedAt: null },
    ])
    expect(customFieldDefs).toHaveBeenCalledWith(session, 't1', 'problem')
  })

  it('every query is scoped to the tenant, and attachments to the entity type', async () => {
    neo.runQueryOne.mockResolvedValue({ props: {}, uProps: null, tProps: null })
    answer({})
    await D.loadTicketDossier(session, fullSpec, 'p1', 't1')
    for (const [, cypher, params] of neo.runQuery.mock.calls as Array<[unknown, string, Record<string, unknown>]>) {
      expect(cypher).toContain('tenant_id: $tenantId')
      expect(params['tenantId']).toBe('t1')
    }
    const attachmentCall = neo.runQuery.mock.calls.find((c) => String(c[1]).includes(':Attachment'))!
    expect(attachmentCall[2]).toMatchObject({ entityType: 'problem', id: 'p1' })
  })

  it('does not query CIs or comments for kinds that have none', async () => {
    neo.runQueryOne.mockResolvedValue({ props: {}, uProps: null, tProps: null })
    answer({})
    const d = await D.loadTicketDossier(session, { label: 'Change', entityType: 'change' }, 'c1', 't1')
    const cyphers = neo.runQuery.mock.calls.map((c) => String(c[1]))
    expect(cyphers.some((c) => c.includes('labels(ci)'))).toBe(false)
    expect(cyphers.some((c) => c.includes('HAS_COMMENT'))).toBe(false)
    expect(d).toMatchObject({ assignee: null, team: null, affectedCIs: [], comments: [] })
  })
})

// ── Rendering ────────────────────────────────────────────────────────────────

/** A real pdfkit document whose text output is recorded. */
function recordingDoc() {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 70, left: 50, right: 50 }, bufferPages: true })
  const written: string[] = []
  const original = doc.text.bind(doc)
  vi.spyOn(doc, 'text').mockImplementation(((t: unknown, ...rest: unknown[]) => {
    written.push(String(t))
    return (original as (...a: unknown[]) => unknown)(t, ...rest)
  }) as never)
  return { doc, written, all: () => written.join('\n') }
}

describe('section renderers', () => {
  it('empty sections say "none" explicitly', () => {
    const { doc, all } = recordingDoc()
    D.affectedCIsSection([], LOCALE)(doc)
    D.workflowHistorySection([], LOCALE)(doc)
    D.commentsSection([], LOCALE)(doc)
    D.attachmentsSection([], LOCALE)(doc)
    for (const key of ['noCIs', 'noWorkflowHistory', 'noComments', 'noAttachments'] as const) {
      expect(all()).toContain(pdfText(LOCALE, key))
    }
  })

  it('an empty custom fields list draws no section at all', () => {
    const { doc, written } = recordingDoc()
    D.customFieldsSection([], LOCALE)(doc)
    expect(written).toEqual([])
  })

  it('custom fields render with a dash for "not filled in"', () => {
    const { doc, all } = recordingDoc()
    D.customFieldsSection([{ label: 'Business impact', value: 'high' }, { label: 'Notes', value: null }], LOCALE)(doc)
    expect(all()).toContain(pdfText(LOCALE, 'customFields'))
    expect(all()).toContain('Business impact')
    expect(all()).toContain('high')
    expect(all()).toContain('—')
  })

  it('tables carry the rows, with dashes for missing values', () => {
    const { doc, all } = recordingDoc()
    D.affectedCIsSection([{ name: 'srv-01', type: 'server', environment: null, status: 'active' }], LOCALE)(doc)
    D.workflowHistorySection([{ stepName: 'in_progress', enteredAt: null, exitedAt: null, durationMs: 60_000, triggeredBy: null, triggerType: 'manual', notes: null }], LOCALE)(doc)
    D.attachmentsSection([{ filename: 'log.txt', sizeBytes: 2048, uploadedBy: null, uploadedAt: null }], LOCALE)(doc)
    const text = all()
    expect(text).toContain('srv-01')
    // Step names are shown as words, not identifiers.
    expect(text).toContain('in progress')
    expect(text).toContain('log.txt')
  })

  it('comments show author, kind and text, with fallbacks for an unknown author and an empty text', () => {
    const { doc, all } = recordingDoc()
    D.commentsSection([
      { author: 'Ada', type: 'workaround', createdAt: null, text: 'reboot the node' },
      { author: null, type: null, createdAt: null, text: '' },
    ], LOCALE)(doc)
    const text = all()
    expect(text).toContain('Ada')
    expect(text).toContain('[workaround]')
    expect(text).toContain('reboot the node')
    expect(text).toContain(pdfText(LOCALE, 'unknownUser'))
  })
})

describe('renderTicketDossier', () => {
  const META = {
    locale: LOCALE, brand: { displayName: 'OpenGrafo', logoPng: null },
    generatedAt: '2026-09-22T10:00:00.000Z', generatedBy: 'test@example.com', tenantId: 't1',
  }

  /** Renders inside the real buffer builder (the header needs the brand it registers). */
  async function render(spec: Parameters<typeof D.renderTicketDossier>[1]): Promise<string[]> {
    const written: string[] = []
    await createPdfBuffer('test', META as never, (doc) => {
      const original = doc.text.bind(doc)
      vi.spyOn(doc, 'text').mockImplementation(((t: unknown, ...rest: unknown[]) => {
        written.push(String(t))
        return (original as (...a: unknown[]) => unknown)(t, ...rest)
      }) as never)
      D.renderTicketDossier(doc, spec)
    })
    return written
  }

  it('draws the header, the badges at the left margin, then every section in order', async () => {
    const order: string[] = []
    const written = await render({
      reportTitle: 'Problem report', entityTitle: 'PRB00000001',
      badges: (d, x) => { order.push(`badges@${String(x)}`); d.text('BADGE') },
      sections: [
        (d) => { order.push(`first@${String(d.x)}`); d.x = 300 },
        // Each section starts at the left margin even if the previous one moved the cursor.
        (d) => { order.push(`second@${String(d.x)}`) },
      ],
    })
    expect(written.join('\n')).toContain('PRB00000001')
    expect(order).toEqual(['badges@50', 'first@50', 'second@50'])
  })

  it('works without badges', async () => {
    const written = await render({ reportTitle: 'Incident report', entityTitle: 'INC1', sections: [] })
    expect(written.join('\n')).toContain('INC1')
  })
})
