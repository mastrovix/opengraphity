/**
 * createRequest — the catalog-form, custom-field and draft-attachment paths.
 *
 * These are the paths a portal user walks when ordering from the catalog. If
 * they regress: answers sent without a catalog item (or to an item with no
 * form) would be silently dropped instead of refused; custom fields would be
 * written without knowing the channel (an end user could fill agent-only
 * fields); table rows would never be written; files uploaded to the form draft
 * would stay orphaned or, worse, files for another item would be claimed; and a
 * tenant with no usable workflow would get a ticket with an invented status.
 *
 * catalogForm / ticketCustomFields are mocked: their own rules are tested in
 * their own files. Here the contract is how createRequest wires them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const tx = { run: vi.fn(async () => ({ records: [{ get: () => 7 }] })) }
  return {
    tx,
    session: {
      executeRead: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      executeWrite: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      close: vi.fn(),
    },
  }
})

vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/ticketCIExclusions.js', () => import('../../lib/__tests__/ticketCIExclusionsFake.js'))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => Number(v),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn() },
  initialStepSelection: vi.fn(),
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../lib/catalogFormLimits.js', () => ({ catalogFormLimits: vi.fn(async () => ({ maxTableRows: 50 })) }))
vi.mock('../../lib/catalogForm.js', () => ({
  parseCatalogForm: vi.fn(),
  formFieldsByName: vi.fn(async () => new Map()),
  resolveFormWrites: vi.fn(),
  writeFormReferences: vi.fn(),
  writeFormTables: vi.fn(),
  claimDraftAttachments: vi.fn(),
}))
vi.mock('../../lib/ticketCustomFields.js', () => ({
  customFieldDefs: vi.fn(async () => [{ name: 'cost_center' }]),
  resolveCustomFieldWrites: vi.fn(() => ({ cf_cost_center: 'CC-1' })),
}))
vi.mock('../../lib/customFieldSteps.js', () => ({ creationStepContext: vi.fn(async () => null) }))

const { createRequest } = await import('../requestService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { initialStepSelection, workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { logger } = await import('../../lib/logger.js')
const cf = await import('../../lib/catalogForm.js')
const tcf = await import('../../lib/ticketCustomFields.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

let catalogRow: Array<{ form: string | null; name: string }> = []

function createParams(): Record<string, unknown> {
  const call = vi.mocked(runQuery).mock.calls.find((c) => String(c[1]).includes('CREATE (r:ServiceRequest'))
  return call![2] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  catalogRow = []
  vi.mocked(initialStepSelection).mockResolvedValue({ definitionId: 'd', stepId: 's', stepName: 'submitted', definitionCategory: null } as never)
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('RETURN i.form AS form')) return catalogRow as never
    if (cypher.includes('CREATE (r:ServiceRequest')) {
      return [{ props: { id: params?.['id'], tenant_id: params?.['tenantId'], title: params?.['title'], status: params?.['status'] } }] as never
    }
    return [] as never
  })
  vi.mocked(cf.parseCatalogForm).mockReturnValue({ version: 1, revision: 3, sections: [] } as never)
  vi.mocked(cf.resolveFormWrites).mockResolvedValue({
    props: { form_os: 'linux' }, references: [], tables: [], attachmentFields: [],
  } as never)
  vi.mocked(cf.claimDraftAttachments).mockResolvedValue({ claimed: 0, leftBehind: 0 } as never)
})

describe('createRequest — form answers without a form', () => {
  it('refuses answers sent without a catalog item (a form belongs to an item)', async () => {
    await expect(createRequest({ title: 'T', priority: 'low', formAnswers: [{ name: 'x', value: '1' }] as never }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.catalogForm.answersWithoutItem' } } })
    // Nothing was created.
    expect(vi.mocked(runQuery).mock.calls.some((c) => String(c[1]).includes('CREATE (r:ServiceRequest'))).toBe(false)
  })

  it('refuses answers to an item that has no form, naming the item', async () => {
    catalogRow = [{ form: null, name: 'New laptop' }]
    vi.mocked(cf.parseCatalogForm).mockReturnValue(null)
    await expect(createRequest({ title: 'T', priority: 'low', catalogItemId: 'cat-1', formAnswers: [{ name: 'x' }] as never }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.catalogForm.noForm', params: { item: 'New laptop' } } } })
  })

  it('an item with an empty (revision 0) form and no answers creates a plain request', async () => {
    catalogRow = []
    vi.mocked(cf.parseCatalogForm).mockReturnValue({ version: 1, revision: 0, sections: [] } as never)
    await createRequest({ title: 'T', priority: 'low', catalogItemId: 'cat-gone' }, ctx)
    expect(createParams()).toMatchObject({ formRevision: null, formProps: {} })
    // The catalog lookup is tenant-scoped.
    const lookup = vi.mocked(runQuery).mock.calls.find((c) => String(c[1]).includes('RETURN i.form AS form'))!
    expect(lookup[2]).toEqual({ itemId: 'cat-gone', tenantId: 'tenant-1' })
  })

  it('names the item by id when the catalog row is missing', async () => {
    vi.mocked(cf.parseCatalogForm).mockReturnValue(null)
    await expect(createRequest({ title: 'T', priority: 'low', catalogItemId: 'cat-9', formAnswers: [{ name: 'x' }] as never }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { params: { item: 'cat-9' } } } })
  })
})

describe('createRequest — form writes', () => {
  it('writes the form props and revision, the table rows, and resolves as the portal channel', async () => {
    catalogRow = [{ form: '{}', name: 'VPN' }]
    const tables = [{ field: 'devices', rows: [{ a: 1 }] }]
    vi.mocked(cf.resolveFormWrites).mockResolvedValue({ props: { form_os: 'linux' }, references: [], tables, attachmentFields: [] } as never)
    await createRequest({ title: 'T', priority: 'low', catalogItemId: 'cat-1', formAnswers: [] }, ctx, 'portal')

    expect(createParams()).toMatchObject({ formRevision: 3, formProps: { form_os: 'linux' } })
    // The server re-decides visibility as an end user when the request comes from the portal.
    expect(vi.mocked(cf.resolveFormWrites).mock.calls[0]![5]).toMatchObject({ endUser: true, draftId: null, userId: 'user-1', maxTableRows: 50 })
    // Table rows hang off the new ticket, inside the creation transaction.
    expect(cf.writeFormTables).toHaveBeenCalledWith(h.tx, 'tenant-1', createParams()['id'], tables)
  })

  it('claims only the files of the attachment fields the form actually asked for, and logs the counts', async () => {
    catalogRow = [{ form: '{}', name: 'VPN' }]
    vi.mocked(cf.resolveFormWrites).mockResolvedValue({
      props: {}, references: [], tables: [], attachmentFields: [{ field: 'photo', count: 1 }],
    } as never)
    vi.mocked(cf.claimDraftAttachments).mockResolvedValue({ claimed: 1, leftBehind: 2 } as never)
    await createRequest({ title: 'T', priority: 'low', catalogItemId: 'cat-1', formDraftId: 'draft-1' }, ctx)

    expect(cf.claimDraftAttachments).toHaveBeenCalledWith(h.tx, 'tenant-1', 'draft-1', 'service_request', createParams()['id'], 'user-1', ['photo'])
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ reclamati: 1 }), 'Form draft attachments claimed')
    // Files nobody asked for are not a silence: they are reported.
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ lasciati: 2, campiAllegato: ['photo'] }), expect.stringContaining('left behind'))
  })

  it('a draft with nothing to claim logs nothing', async () => {
    await createRequest({ title: 'T', priority: 'low', formDraftId: 'draft-1' }, ctx)
    // A request without a form has no attachment fields: it claims nothing.
    expect(vi.mocked(cf.claimDraftAttachments).mock.calls[0]![6]).toEqual([])
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('createRequest — custom fields', () => {
  it('resolves custom fields for the service_request type with the channel, and writes them', async () => {
    await createRequest({ title: 'T', priority: 'low', customFields: [{ name: 'cost_center', value: 'CC-1' }] as never }, ctx, 'portal')
    expect(tcf.customFieldDefs).toHaveBeenCalledWith(h.session, 'tenant-1', 'service_request')
    expect(vi.mocked(tcf.resolveCustomFieldWrites).mock.calls[0]![0]).toBe('tenant-1')
    expect(vi.mocked(tcf.resolveCustomFieldWrites).mock.calls[0]![4]).toMatchObject({ current: null, endUser: true })
    expect(createParams()['customProps']).toEqual({ cf_cost_center: 'CC-1' })
  })
})

describe('createRequest — no usable workflow', () => {
  it('fails instead of creating a ticket with an invented status', async () => {
    vi.mocked(initialStepSelection).mockResolvedValue(null as never)
    await expect(createRequest({ title: 'T', priority: 'low', category: 'hardware' }, ctx))
      .rejects.toThrow('No usable service_request workflow for tenant "tenant-1" (category hardware)')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('says "none" when there was no category', async () => {
    vi.mocked(initialStepSelection).mockResolvedValue(null as never)
    await expect(createRequest({ title: 'T', priority: 'low' }, ctx)).rejects.toThrow('(category none)')
  })
})
