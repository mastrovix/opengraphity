/**
 * The read side of the customer's ticket fields, and the edges of the write.
 *
 * Why these behaviours matter:
 *  - a portal user must only ever see fields flagged "visible to end user":
 *    the rest are internal notes of the service desk;
 *  - a list of 50 tickets must read the field definitions ONCE per request and
 *    per type, not once per row (the page would otherwise fan out 50 queries);
 *  - the ticket's workflow step is read only when a field has step rules:
 *    otherwise every ticket in a list pays for a graph read it does not need;
 *  - enum values are shown with the customer's labels in the viewer's language,
 *    falling back to the tenant language for an unknown one;
 *  - the opening form must compute visibility on the step the engine will
 *    actually choose (type AND category), or the form offers a field the API
 *    then refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import { withTicketProps } from '../../../lib/ticketProps.js'

const h = vi.hoisted(() => ({
  runQueryOne: vi.fn(),
  customFieldDefs: vi.fn(),
  loadTicketProps: vi.fn(),
  ticketStepContext: vi.fn(),
  creationStepContext: vi.fn(),
  workflowStepsByDefinition: vi.fn(),
  loadVocabularyEntries: vi.fn(),
  languageFor: vi.fn(),
  withSession: vi.fn(),
}))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: h.runQueryOne }))
vi.mock('../ci-utils.js', () => ({ withSession: h.withSession }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn(async () => {}) }))
vi.mock('../../../lib/ticketUpdated.js', () => ({ publishTicketUpdated: vi.fn(async () => {}) }))
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: vi.fn(async () => {}) }))
vi.mock('../../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries: h.loadVocabularyEntries }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: h.languageFor }))
vi.mock('../../../lib/customFieldSteps.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ticketStepContext: h.ticketStepContext,
  creationStepContext: h.creationStepContext,
  workflowStepsByDefinition: h.workflowStepsByDefinition,
}))
vi.mock('../../../lib/ticketCustomFields.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  customFieldDefs: h.customFieldDefs,
  loadTicketProps: h.loadTicketProps,
}))

const { ticketCustomFieldResolvers: R, requestCustomFieldDefs } = await import('../ticketCustomFields.js')

const def = (name: string, extra: Record<string, unknown> = {}) => ({
  name, label: name.toUpperCase(), fieldType: 'string', required: false, enumValues: [], enumTypeName: null,
  validationScript: null, visibleToEndUser: false, order: 1,
  visibility: { mode: 'always' }, editability: { mode: 'visible' }, ...extra,
})

const staff = () => ({ tenantId: 't1', userId: 'u1', role: 'operator', permissions: perms('operator') }) as never
// No "workspace.use" permission: the caller only comes in through the portal.
const portal = () => ({ tenantId: 't1', userId: 'u2', role: 'end_user', permissions: new Set() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.withSession.mockImplementation(async (fn: (s: unknown) => unknown) => fn({}))
  h.languageFor.mockResolvedValue('en')
  h.ticketStepContext.mockResolvedValue(null)
  h.creationStepContext.mockResolvedValue(null)
})

describe('requestCustomFieldDefs', () => {
  it('reads the definitions once per request and per type', async () => {
    h.customFieldDefs.mockResolvedValue([def('a')])
    const ctx = staff()
    await requestCustomFieldDefs(ctx, 'incident')
    await requestCustomFieldDefs(ctx, 'incident')
    await requestCustomFieldDefs(ctx, 'change')
    // Two types, two reads: a list of tickets does not multiply them.
    expect(h.customFieldDefs).toHaveBeenCalledTimes(2)
    expect(h.customFieldDefs.mock.calls.map((c) => c[1])).toEqual(['t1', 't1'])
    // A new request starts from scratch: definitions edited meanwhile are seen.
    await requestCustomFieldDefs(staff(), 'incident')
    expect(h.customFieldDefs).toHaveBeenCalledTimes(3)
  })
})

describe('Ticket.customFields', () => {
  it('no customer fields: an empty list, without reading the ticket', async () => {
    h.customFieldDefs.mockResolvedValue([])
    expect(await R.Incident.customFields({ id: 'inc-1' }, null, staff())).toEqual([])
    expect(h.loadTicketProps).not.toHaveBeenCalled()
  })

  it('uses the props the mapper attached, without re-reading the ticket', async () => {
    h.customFieldDefs.mockResolvedValue([def('color')])
    const parent = withTicketProps({ id: 'inc-1' }, { color: 'red' })
    const out = await R.Incident.customFields(parent, null, staff())
    expect(out).toEqual([expect.objectContaining({ name: 'color', value: 'red', visible: true, editable: true })])
    expect(h.loadTicketProps).not.toHaveBeenCalled()
    // No field has step rules: the step is not worth a read.
    expect(h.ticketStepContext).not.toHaveBeenCalled()
  })

  it('reads the ticket when the mapper did not attach props, scoped to the tenant', async () => {
    h.customFieldDefs.mockResolvedValue([def('color')])
    h.loadTicketProps.mockResolvedValue({ color: 'blue' })
    const out = await R.Problem.customFields({ id: 'prb-1' }, null, staff())
    expect(h.loadTicketProps.mock.calls[0]!.slice(1)).toEqual(['t1', 'problem', 'prb-1'])
    expect(out[0]!.value).toBe('blue')
  })

  it('a ticket that cannot be read shows empty values instead of failing the whole list', async () => {
    h.customFieldDefs.mockResolvedValue([def('color')])
    h.loadTicketProps.mockResolvedValue(null)
    const out = await R.Change.customFields({ id: 'chg-1' }, null, staff())
    expect(out[0]!.value).toBeNull()
  })

  it('with step rules, visibility follows the step the ticket is in', async () => {
    h.customFieldDefs.mockResolvedValue([
      def('early', { visibility: { mode: 'steps', steps: ['new'] } }),
      def('late', { editability: { mode: 'steps', steps: ['review'] } }),
    ])
    h.ticketStepContext.mockResolvedValue({ current: 'review', visited: ['new'] })
    const out = await R.ServiceRequest.customFields(withTicketProps({ id: 'sr-1' }, {}), null, staff())
    expect(h.ticketStepContext.mock.calls[0]!.slice(1)).toEqual(['t1', 'sr-1'])
    expect(out.find((f) => f.name === 'early')).toMatchObject({ visible: false, editable: false })
    expect(out.find((f) => f.name === 'late')).toMatchObject({ visible: true, editable: true })
  })

  it('a portal user sees only the fields flagged visible to end users', async () => {
    h.customFieldDefs.mockResolvedValue([def('internal'), def('public', { visibleToEndUser: true })])
    const parent = withTicketProps({ id: 'inc-1' }, { internal: 'x', public: 'y' })
    expect((await R.Incident.customFields(parent, null, portal())).map((f) => f.name)).toEqual(['public'])
    expect((await R.Incident.customFields(parent, null, staff())).map((f) => f.name)).toEqual(['internal', 'public'])
  })
})

describe('setTicketCustomFields', () => {
  it('a ticket deleted between read and write is NOT_FOUND, not a silent success', async () => {
    h.loadTicketProps.mockResolvedValue({ id: 'inc-1', note: null })
    h.customFieldDefs.mockResolvedValue([def('note')])
    h.runQueryOne.mockResolvedValue(null)
    await expect(R.Mutation.setTicketCustomFields(null, { entityType: 'incident', id: 'inc-1', values: [{ name: 'note', value: 'hi' }] }, staff()))
      .rejects.toThrow(/not found/i)
  })
})

describe('CustomFieldValue.options / valueLabel', () => {
  const enumField = { name: 'outcome', fieldType: 'enum', value: 'ok', enumValues: ['ok', 'ko'], enumTypeName: 'outcome_vocab' } as never
  const labels = { ok: { en: 'Successful', it: 'Riuscita' }, ko: { en: 'Failed' } }

  it('labels the options in the requested language, falling back to the tenant language', async () => {
    h.loadVocabularyEntries.mockResolvedValue({ values: ['ok', 'ko'], labels, colors: {} })
    h.languageFor.mockResolvedValue('en')
    const out = await R.CustomFieldValue.options(enumField, { language: 'it' }, staff())
    // "ko" has no Italian label: the tenant language is still better than the raw value.
    expect(out).toEqual([{ value: 'ok', label: 'Riuscita' }, { value: 'ko', label: 'Failed' }])
    expect(h.loadVocabularyEntries).toHaveBeenCalledWith('t1', 'outcome_vocab')
  })

  it('an unknown language uses the tenant language', async () => {
    h.loadVocabularyEntries.mockResolvedValue({ values: [], labels, colors: {} })
    h.languageFor.mockResolvedValue('it')
    const out = await R.CustomFieldValue.options(enumField, { language: 'fr' }, staff())
    expect(out[0]!.label).toBe('Riuscita')
    const noLang = await R.CustomFieldValue.options(enumField, {}, staff())
    expect(noLang[0]!.label).toBe('Riuscita')
  })

  it('a form with many fields on the same vocabulary reads it once per request', async () => {
    h.loadVocabularyEntries.mockResolvedValue({ values: [], labels, colors: {} })
    const ctx = staff()
    await R.CustomFieldValue.options(enumField, {}, ctx)
    await R.CustomFieldValue.valueLabel(enumField, {}, ctx)
    expect(h.loadVocabularyEntries).toHaveBeenCalledTimes(1)
  })

  it('options of a field without a vocabulary are the raw values', async () => {
    const f = { fieldType: 'enum', value: null, enumValues: ['a'], enumTypeName: null } as never
    expect(await R.CustomFieldValue.options(f, {}, staff())).toEqual([{ value: 'a', label: 'a' }])
    expect(h.loadVocabularyEntries).not.toHaveBeenCalled()
  })

  it('valueLabel: null stays null, an enum is labelled, anything else is the value itself', async () => {
    h.loadVocabularyEntries.mockResolvedValue({ values: [], labels, colors: {} })
    expect(await R.CustomFieldValue.valueLabel({ ...(enumField as object), value: null } as never, {}, staff())).toBeNull()
    expect(await R.CustomFieldValue.valueLabel(enumField, { language: 'en' }, staff())).toBe('Successful')
    expect(await R.CustomFieldValue.valueLabel({ fieldType: 'string', value: 'free text' } as never, {}, staff())).toBe('free text')
  })
})

describe('ticketCreationCustomFields', () => {
  it('a type without custom fields is refused', async () => {
    await expect(R.Query.ticketCreationCustomFields(null, { entityType: 'kb_article' }, staff())).rejects.toThrow(/has no custom fields/)
  })

  it('computes the form on the initial step of the workflow chosen for type AND category', async () => {
    h.customFieldDefs.mockResolvedValue([def('later', { visibility: { mode: 'from', step: 'triage' } }), def('always')])
    h.creationStepContext.mockResolvedValue({ current: 'new', visited: [] })
    const out = await R.Query.ticketCreationCustomFields(null, { entityType: 'incident', category: 'network' }, staff())
    expect(h.creationStepContext.mock.calls[0]!.slice(1)).toEqual(['t1', 'incident', 'network'])
    expect(out.map((f) => [f.name, f.visible, f.value])).toEqual([['later', false, null], ['always', true, null]])
  })

  it('without a category the generic workflow is asked for (null, not undefined)', async () => {
    h.customFieldDefs.mockResolvedValue([])
    await R.Query.ticketCreationCustomFields(null, { entityType: 'change' }, staff())
    expect(h.creationStepContext.mock.calls[0]![3]).toBeNull()
  })
})

describe('ticketWorkflowSteps', () => {
  it('exposes each step with its shipped translations', async () => {
    h.workflowStepsByDefinition.mockResolvedValue([{
      workflow: 'Incident standard', category: null,
      steps: [
        { name: 'new', label: 'New', labels: JSON.stringify({ it: 'Nuovo', en: 'New' }), order: 1 },
        { name: 'closed', label: 'Closed', labels: null, order: 2 },
      ],
    }])
    const out = await R.Query.ticketWorkflowSteps(null, { entityType: 'incident' }, staff())
    expect(h.workflowStepsByDefinition.mock.calls[0]!.slice(1)).toEqual(['t1', 'incident'])
    expect(out).toEqual([{
      workflow: 'Incident standard', category: null,
      steps: [
        { name: 'new', label: 'New', labels: [{ language: 'it', label: 'Nuovo' }, { language: 'en', label: 'New' }] },
        { name: 'closed', label: 'Closed', labels: [] },
      ],
    }])
  })
})

describe('CIFieldDef', () => {
  it('visibleToEndUser is true only when explicitly set', () => {
    expect(R.CIFieldDef.visibleToEndUser({ visibleToEndUser: true })).toBe(true)
    expect(R.CIFieldDef.visibleToEndUser({})).toBe(false)
  })

  it('step rules default to always visible and editable where visible', () => {
    expect(R.CIFieldDef.stepVisibility({ name: 'x' })).toEqual({ mode: 'always', steps: [], step: null })
    expect(R.CIFieldDef.stepEditability({})).toEqual({ mode: 'visible', steps: [] })
  })

  it('saved rules are exposed in the shape the designer reads', () => {
    expect(R.CIFieldDef.stepVisibility({ name: 'x', stepVisibilityRaw: '{"mode":"steps","steps":["a"]}' }))
      .toEqual({ mode: 'steps', steps: ['a'], step: null })
    expect(R.CIFieldDef.stepVisibility({ name: 'x', stepVisibilityRaw: '{"mode":"from","step":"b"}' }))
      .toEqual({ mode: 'from', steps: [], step: 'b' })
    expect(R.CIFieldDef.stepEditability({ name: 'x', stepEditabilityRaw: '{"mode":"steps","steps":["c"]}' }))
      .toEqual({ mode: 'steps', steps: ['c'] })
  })

  it('a corrupt saved rule fails loud, naming the field', () => {
    expect(() => R.CIFieldDef.stepVisibility({ name: 'broken', stepVisibilityRaw: '{nope' })).toThrow(/field broken/)
  })
})
