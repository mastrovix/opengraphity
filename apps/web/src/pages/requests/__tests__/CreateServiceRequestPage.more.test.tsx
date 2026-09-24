/**
 * Creating a service request from the operator workspace. The existing test
 * file covers the due date, the priority and the description that follows the
 * catalog item; this one covers the rest of what a person relies on here:
 *
 * - The catalog form of the chosen item: what reaches the API is only what is
 *   visible now (a hidden answer is rejected by the server, so it would block
 *   the request), references travel as ids, attachments travel as the draft
 *   they were uploaded to, table rows travel without the empty ones, and a
 *   computed value is never thrown away (doing so looped forever).
 * - A server rejection lights up the field it blames; a form republished while
 *   filling drops the stale answers and reloads.
 * - Reference search asks the right query per kind of reference, and a CI
 *   search honours the field's types, its filter and the CI types excluded
 *   for service requests (offering a CI the server will refuse is a trap).
 * - Validation says what is missing instead of doing nothing; the SLA check
 *   runs before creating, and its three outcomes behave differently.
 *
 * The catalog form renderer is replaced by a thin stand-in that exposes each
 * callback as a button: the renderer has its own tests in web-core, while the
 * page's job is what it does with those callbacks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto, nomeOperazione } from '@/test/apolloFinto'
import { CreateServiceRequestPage } from '../CreateServiceRequestPage'

/*
 * Mutations as Apollo Client 4 runs them (useMutation.js, 4.3.1): a failed one
 * calls its `onError`, THEN rejects — the shared fake resolves instead. As in
 * Apollo, a promise nobody awaits stays quiet.
 */
vi.mock('@apollo/client/react', async () => {
  const base = (await import('@/test/apolloFinto')).moduloApollo()
  type Mutate = (options?: unknown) => Promise<{ data?: unknown; errors?: unknown[] } | undefined>
  return {
    ...base,
    useMutation: (...args: Parameters<typeof base.useMutation>) => {
      const [mutate, result] = base.useMutation(...args) as unknown as [Mutate, Record<string, unknown>]
      const likeApollo4: Mutate = (options) => {
        const promise = mutate(options).then((r) => {
          if (r?.errors?.length) throw r.errors[0]
          return r
        })
        promise.catch(() => {})
        return promise
      }
      return [likeApollo4, result] as const
    },
  }
})

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
  Toaster: () => null,
}))

const slaCheck = vi.fn<(input: unknown) => Promise<string>>()
vi.mock('@/hooks/useSlaCoverageCheck', () => ({ useSlaCoverageCheck: () => slaCheck }))
// The tenant's field rules (review of 23 Sep 2026), none unless a test sets them.
const fieldRules = vi.hoisted(() => ({ rules: {} as Record<string, { visible: boolean; required: boolean }> }))
vi.mock('@/hooks/useFormFieldRules', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useFormFieldRules')>()),
  useFormFieldRules: () => ({ rules: fieldRules.rules, error: null }),
}))

const enumState = { values: ['low', 'high'], loading: false }
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => enumState }))
vi.mock('@/hooks/useValueStyle', () => ({ useValueStyle: () => () => ({ bg: '', color: '', accent: 'red' }) }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({
    // Only `hw` and `low` have a vocabulary label: the rest shows the fallbacks.
    labelOf: (voc: string, v: string) => (voc === 'category' && v === 'hw' ? 'Hardware' : voc === 'priority' && v === 'low' ? 'Low (P4)' : null),
  }),
}))

const upload = vi.fn<(draft: string, field: string, file: File) => Promise<{ id: string; filename: string; sizeBytes: number }>>()
vi.mock('@/lib/formDraftUpload', () => ({ uploadFormDraftFile: (d: string, f: string, file: File) => upload(d, f, file) }))

vi.mock('@opengraphity/web-core', async (orig) => {
  const real = await orig<typeof import('@opengraphity/web-core')>()
  const { useState } = await import('react')
  type Props = import('@opengraphity/web-core').CatalogFormRendererProps
  type Ref = import('@opengraphity/web-core').CatalogFormReference
  /** Stand-in renderer: each callback of the real one becomes a labelled control. */
  function FakeRenderer(p: Props) {
    const [found, setFound] = useState<Record<string, readonly Ref[] | 'none'>>({})
    const visible = real.visibleCatalogFormItems(p.definition, p.answers)
    return (
      <div data-testid="catalog-form">
        <output data-testid="answers">{JSON.stringify(p.answers)}</output>
        <button type="button" onClick={() => p.onChange('total', 42)}>compute total</button>
        {visible.map((item) => {
          const f = p.fields.find((x) => x.name === item.field)
          if (!f) return null
          const err = p.errors?.[f.name]
          const errorLine = err ? <p role="alert">{`${f.name}: ${err}`}</p> : null
          if (f.fieldType === 'attachment') {
            return (
              <div key={f.name}>
                <button type="button" onClick={() => void p.onUploadFile?.(f.name, new File(['x'], 'spec.pdf'))}>{`upload ${f.name}`}</button>
                {p.uploadingField === f.name && <span>uploading</span>}
                {(p.files?.[f.name] ?? []).map((file) => (
                  <button key={file.id} type="button" onClick={() => void p.onRemoveFile?.(f.name, file.id)}>{`remove ${file.filename}`}</button>
                ))}
                {errorLine}
              </div>
            )
          }
          if (f.fieldType.startsWith('ref_')) {
            const results = found[f.name]
            return (
              <div key={f.name}>
                <button type="button" onClick={() => void p.onSearchReference?.(f, 'Web').then((r) => setFound((s) => ({ ...s, [f.name]: r.length ? r : 'none' })))}>{`search ${f.name}`}</button>
                {results === 'none' && <span>{`${f.name}: no results`}</span>}
                {Array.isArray(results) && results.map((r) => (
                  <button key={r.id} type="button" onClick={() => p.onPickReference?.(f.name, r)}>{`pick ${r.label}`}</button>
                ))}
                {p.references?.[f.name]?.[0] && <span>{`chosen ${p.references[f.name]?.[0]?.label}`}</span>}
                <button type="button" onClick={() => p.onPickReference?.(f.name, null)}>{`clear ${f.name}`}</button>
              </div>
            )
          }
          if (f.fieldType === 'table') {
            return (
              <button key={f.name} type="button" onClick={() => p.onTablesChange?.(f.name, [{ qty: '2' }, { qty: ' ' }])}>{`add rows ${f.name}`}</button>
            )
          }
          return (
            <div key={f.name}>
              <input aria-label={f.name} value={String(p.answers[f.name] ?? '')} onChange={(e) => p.onChange(f.name, e.target.value)} />
              {errorLine}
            </div>
          )
        })}
      </div>
    )
  }
  return { ...real, CatalogFormRenderer: FakeRenderer }
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const shownWhen = (value: string) => ({ match: 'all' as const, rules: [{ field: 'kind', op: 'eq' as const, value }] })

const definition = {
  version: 1, revision: 3,
  sections: [{ id: 'main', title: {}, items: [
    { field: 'kind' },
    { field: 'detail', visibleWhen: shownWhen('yes') },
    // A computed field hidden by a condition: its value must survive anyway.
    { field: 'total', visibleWhen: shownWhen('never') },
    { field: 'info' }, { field: 'doc' },
    { field: 'server' }, { field: 'anyci' }, { field: 'owner' }, { field: 'team' },
    { field: 'lines' },
  ] }],
}

const fields = [
  { name: 'kind', fieldType: 'text', label: 'Kind', required: false },
  { name: 'detail', fieldType: 'text', label: 'Detail', required: false },
  { name: 'total', fieldType: 'number', label: 'Total', required: false, formula: 'return 1' },
  { name: 'info', fieldType: 'note', label: 'Info', required: false },
  { name: 'doc', fieldType: 'attachment', label: 'Doc', required: false },
  { name: 'server', fieldType: 'ref_ci', label: 'Server', required: false, refTypes: ['server'], refFilter: '{"rules":[]}' },
  { name: 'anyci', fieldType: 'ref_ci', label: 'Any CI', required: false, refTypes: [], refFilter: '' },
  { name: 'owner', fieldType: 'ref_user', label: 'Owner', required: false },
  { name: 'team', fieldType: 'ref_team', label: 'Team', required: false },
  { name: 'lines', fieldType: 'table', label: 'Lines', required: false },
]

const items = [
  { id: 'cat-1', name: 'New laptop', description: 'A company laptop', category: 'hw', requiresApproval: true, priority: 'high', active: true },
  { id: 'cat-2', name: 'App access', description: null, category: 'access', requiresApproval: false, priority: null, active: true, fulfillmentTeam: { id: 't-iam', name: 'Identity' } },
  { id: 'cat-3', name: 'Retired item', description: null, category: null, requiresApproval: false, priority: null, active: false },
]

interface SetupOpts { definitionText?: string; customFields?: unknown[]; excluded?: string[] | null }

function setup(opts: SetupOpts = {}) {
  apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: items }
  apolloFinto.risposte['GetCatalogFormToFill'] = (v?: Record<string, unknown>) =>
    v?.['itemId'] === 'cat-1'
      ? { catalogFormToFill: { itemId: 'cat-1', revision: 3, definition: opts.definitionText ?? JSON.stringify(definition), fields } }
      : { catalogFormToFill: null }
  apolloFinto.risposte['GetTicketCreationCustomFields'] = { ticketCreationCustomFields: opts.customFields ?? [] }
  if (opts.excluded !== null) {
    apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'service_request', ciTypes: opts.excluded ?? ['firewall'] }] }
  }
  return renderWithProviders(<CreateServiceRequestPage />)
}

type User = ReturnType<typeof setup>['user']

async function chooseItem(user: User, id: string) {
  await user.selectOptions(screen.getByRole('combobox', { name: /Catalog item/ }), id)
}

async function submit(user: User) {
  await user.click(screen.getByRole('button', { name: 'Create the request' }))
}

function sentInput(): Record<string, unknown> {
  return (apolloFinto.chiamata('CreateServiceRequest') as { input: Record<string, unknown> }).input
}

function answers(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('answers').textContent ?? '{}') as Record<string, unknown>
}

/** Runs `body` while collecting the promise rejections nobody handled. */
async function collectingUnhandledRejections(body: (seen: unknown[]) => Promise<void>): Promise<void> {
  const seen: unknown[] = []
  const listener = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await body(seen)
  } finally {
    process.off('unhandledRejection', listener)
  }
}

beforeEach(() => {
  apolloFinto.reset()
  fieldRules.rules = {}
  toastSuccess.mockClear()
  toastError.mockClear()
  slaCheck.mockReset()
  slaCheck.mockResolvedValue('covered')
  upload.mockReset()
  enumState.values = ['low', 'high']
  enumState.loading = false
  apolloFinto.query.mockImplementation(async (o: { query: Parameters<typeof nomeOperazione>[0] }) => {
    switch (nomeOperazione(o.query)) {
      case 'GetAllCIs': return { data: { allCIs: { items: [{ id: 'ci-1', name: 'web-01' }] } } }
      case 'GetUsers': return { data: { users: [
        { id: 'u1', name: 'Web Admin', email: 'admin@x.io' },
        { id: 'u2', name: '', email: 'web@x.io' },
        { id: 'u3', name: 'Zed', email: 'zed@x.io' },
      ] } }
      case 'GetTeams': return { data: { teams: [{ id: 't1', name: 'Web team' }, { id: 't2', name: 'DBA' }] } }
      default: return { data: undefined }
    }
  })
})

// ── The page around the form ──────────────────────────────────────────────────

describe('CreateServiceRequestPage — catalog and fields', () => {
  it('lists only active items, with the category label from the vocabulary or the raw value', () => {
    setup()
    const options = Array.from((screen.getByRole('combobox', { name: /Catalog item/ }) as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options).toEqual(['— Generic request (no catalog item) —', 'Hardware · New laptop', 'access · App access'])
  })

  it('warns that an item needs approval, and only that item', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    expect(screen.getByText(/needs an approval/)).toBeInTheDocument()
    await chooseItem(user, 'cat-2')
    expect(screen.queryByText(/needs an approval/)).not.toBeInTheDocument()
  })

  it('a hand-written title survives choosing an item; an automatic one follows the item', async () => {
    const { user } = setup()
    const title = screen.getByPlaceholderText('What do you need?')
    await chooseItem(user, 'cat-1')
    expect(title).toHaveValue('New laptop')
    // The title set by the previous item is automatic: it follows the new one.
    await chooseItem(user, 'cat-2')
    expect(title).toHaveValue('App access')
    // An item without a priority keeps the one already chosen.
    expect(screen.getByLabelText(/Priority/)).toHaveValue('high')
    await user.clear(title)
    await user.type(title, 'Laptop for Rossi - urgent')
    await chooseItem(user, 'cat-1')
    expect(title).toHaveValue('Laptop for Rossi - urgent')
  })

  it('priority labels come from the vocabulary, else the capitalised value; while loading the select is disabled', () => {
    const { unmount } = setup()
    const labels = Array.from((screen.getByLabelText(/Priority/) as HTMLSelectElement).options).map((o) => o.textContent)
    expect(labels).toEqual(['— Choose the priority —', 'Low (P4)', 'High'])
    unmount()
    enumState.loading = true
    setup()
    expect(screen.getByLabelText(/Priority/)).toBeDisabled()
    expect(screen.getByLabelText(/Priority/)).toHaveTextContent('Loading...')
  })

  it('an empty submit says which fields are missing, and editing clears the message', async () => {
    const { user } = setup()
    await submit(user)
    expect(screen.getAllByText('Required field')).toHaveLength(2)
    expect(screen.getByLabelText(/Priority/)).toHaveAttribute('aria-invalid', 'true')
    expect(apolloFinto.chiamata('CreateServiceRequest')).toBeUndefined()
    await user.type(screen.getByPlaceholderText('What do you need?'), 'X')
    expect(screen.queryAllByText('Required field')).toHaveLength(0)
    await submit(user)
    await user.selectOptions(screen.getByLabelText(/Priority/), 'low')
    expect(screen.getByLabelText(/Priority/)).not.toHaveAttribute('aria-invalid')
  })

  it('focus and hover give visual feedback and never break the fields', async () => {
    const { user } = setup()
    const title = screen.getByPlaceholderText('What do you need?')
    await user.click(title)
    expect(title.style.boxShadow).not.toBe('none')
    await user.tab()
    expect(title.style.boxShadow).toBe('none')
    await submit(user)
    // After a failed submit the blurred field keeps the error colour.
    await user.click(title)
    await user.tab()
    expect(title.style.borderColor).toBe('var(--color-trigger-sla-breach)')
    for (const name of ['Back to the requests', 'Cancel', 'Create the request']) {
      const b = screen.getByRole('button', { name })
      await user.hover(b)
      await user.unhover(b)
    }
    expect(screen.getByRole('button', { name: 'Create the request' })).toBeEnabled()
  })

  it('Back and Cancel return to the request list', async () => {
    const { user, unmount } = setup()
    await user.click(screen.getByRole('button', { name: 'Back to the requests' }))
    await attendiURL('/requests')
    unmount()
    const again = setup()
    await again.user.click(screen.getByRole('button', { name: 'Cancel' }))
    await attendiURL('/requests')
  })
})

describe('CreateServiceRequestPage — custom fields and SLA', () => {
  const costCenter = { name: 'cost_center', label: 'Cost center', fieldType: 'string', required: true, enumValues: [], enumTypeName: null, visibleToEndUser: false, value: null }

  async function fillBasics(user: User) {
    await user.type(screen.getByPlaceholderText('What do you need?'), 'Laptop')
    await user.selectOptions(screen.getByLabelText(/Priority/), 'high')
  }

  it('a required custom field blocks the request until filled, then is sent', async () => {
    const { user } = setup({ customFields: [costCenter] })
    await fillBasics(user)
    await submit(user)
    expect(screen.getByRole('alert')).toHaveTextContent('Required field')
    expect(apolloFinto.chiamata('CreateServiceRequest')).toBeUndefined()
    await user.type(screen.getByLabelText(/Cost center/), 'CC-7')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await submit(user)
    await waitFor(() => expect(sentInput()).toMatchObject({ customFields: [{ name: 'cost_center', value: 'CC-7' }] }))
  })

  it('created: says so and goes to the list; a generic request sends no form', async () => {
    const { user, container } = setup()
    await fillBasics(user)
    await user.type(screen.getByLabelText(/Description/), 'For the new hire')
    const due = container.querySelector('input[type=date]') as HTMLInputElement
    await user.click(due)
    await user.type(due, '2026-10-01')
    await submit(user)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Service request created'))
    await attendiURL('/requests')
    const input = sentInput()
    expect(input).toMatchObject({ title: 'Laptop', priority: 'high', description: 'For the new hire', dueDate: '2026-10-01' })
    expect(input['formAnswers']).toBeUndefined()
    expect(input['formDraftId']).toBeUndefined()
    expect(input['catalogItemId']).toBeUndefined()
    expect(input).not.toHaveProperty('acknowledgeNoSla')
  })

  // Review of 23 Sep 2026: the check asked with no category and no team, and a category-scoped policy looked absent.
  it('the SLA check asks with the catalog item\'s category and fulfilment team, as the request will have them', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-2')
    await fillBasics(user)
    await submit(user)
    await waitFor(() => expect(slaCheck).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'service_request', category: 'access', categoryLabel: 'access', teamId: 't-iam', teamName: 'Identity',
    })))
  })

  it('a due date made required by a rule is marked, and the request is not sent without it; a hidden description is not shown', async () => {
    fieldRules.rules = { dueDate: { visible: true, required: true }, description: { visible: false, required: false } }
    const { user } = setup()
    expect(screen.queryByPlaceholderText(/Describe/)).not.toBeInTheDocument()
    expect((screen.getByLabelText(/^Due date/) as HTMLInputElement).labels?.[0]?.textContent).toMatch(/\*$/)
    await fillBasics(user)
    await submit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Required field')
    expect(apolloFinto.chiamata('CreateServiceRequest')).toBeUndefined()
  })

  it('no SLA policy and the person goes back: nothing is created', async () => {
    slaCheck.mockResolvedValue('cancelled')
    const { user } = setup()
    await fillBasics(user)
    await submit(user)
    await waitFor(() => expect(slaCheck).toHaveBeenCalled())
    expect(apolloFinto.chiamata('CreateServiceRequest')).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Create the request' })).toBeEnabled()
  })

  it('no SLA policy and the person accepts: the request carries the acceptance', async () => {
    slaCheck.mockResolvedValue('accepted')
    const { user } = setup()
    await fillBasics(user)
    await submit(user)
    await waitFor(() => expect(sentInput()).toMatchObject({ acknowledgeNoSla: true }))
  })

  it('the SLA check failing is said, and nothing is created blind', async () => {
    slaCheck.mockRejectedValueOnce(new Error('api down')).mockRejectedValueOnce('plain failure')
    const { user } = setup()
    await fillBasics(user)
    await submit(user)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not check whether an SLA policy covers the service request: api down'))
    await submit(user)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not check whether an SLA policy covers the service request: plain failure'))
    expect(apolloFinto.chiamata('CreateServiceRequest')).toBeUndefined()
  })

  it('while the SLA check runs the button cannot send a second request', async () => {
    let answer: (v: string) => void = () => {}
    slaCheck.mockImplementation(() => new Promise((r) => { answer = r }))
    const { user } = setup()
    await fillBasics(user)
    await submit(user)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create the request' })).toBeDisabled())
    answer('covered')
    await waitFor(() => expect(apolloFinto.chiamata('CreateServiceRequest')).toBeDefined())
  })
})

// ── The catalog form ──────────────────────────────────────────────────────────

describe('CreateServiceRequestPage — the catalog form', () => {
  it('an item without a published form, or with an unreadable one, shows no form', async () => {
    const { user, unmount } = setup()
    await chooseItem(user, 'cat-2')
    expect(screen.queryByTestId('catalog-form')).not.toBeInTheDocument()
    unmount()
    const again = setup({ definitionText: '{not json' })
    await chooseItem(again.user, 'cat-1')
    expect(screen.queryByTestId('catalog-form')).not.toBeInTheDocument()
    // Still creatable: the revision goes along, the answers do not.
    await again.user.type(screen.getByPlaceholderText('What do you need?'), ' now')
    await submit(again.user)
    await waitFor(() => expect(sentInput()).toMatchObject({ formRevision: 3, catalogItemId: 'cat-1' }))
    expect(sentInput()['formAnswers']).toBeUndefined()
  })

  it('an answer hidden by a condition is forgotten, a computed value is kept', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.type(screen.getByLabelText('kind'), 'yes')
    await user.type(screen.getByLabelText('detail'), 'SSD')
    await user.click(screen.getByRole('button', { name: 'compute total' }))
    expect(answers()).toMatchObject({ kind: 'yes', detail: 'SSD', total: 42 })
    await user.clear(screen.getByLabelText('kind'))
    await user.type(screen.getByLabelText('kind'), 'no')
    expect(screen.queryByLabelText('detail')).not.toBeInTheDocument()
    // `detail` is gone (the server would refuse it); `total` is not an answer, it stays.
    expect(answers()).toEqual({ kind: 'no', total: 42 })
  })

  it('sends visible answers, references as ids, table rows without empty ones, never notes or computed values', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.type(screen.getByLabelText('kind'), 'yes')
    await user.type(screen.getByLabelText('detail'), 'SSD')
    await user.click(screen.getByRole('button', { name: 'compute total' }))
    await user.click(screen.getByRole('button', { name: 'search server' }))
    await user.click(await screen.findByRole('button', { name: 'pick web-01' }))
    expect(screen.getByText('chosen web-01')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'add rows lines' }))
    await submit(user)
    await waitFor(() => expect(apolloFinto.chiamata('CreateServiceRequest')).toBeDefined())
    const input = sentInput()
    expect(input).toMatchObject({ title: 'New laptop', priority: 'high', description: 'A company laptop', catalogItemId: 'cat-1', formRevision: 3 })
    expect(input['formAnswers']).toEqual([
      { name: 'kind', value: 'yes' },
      { name: 'detail', value: 'SSD' },
      { name: 'server', refIds: ['ci-1'] },
      // A reference nobody picked is sent empty, not skipped.
      { name: 'anyci', refIds: [] },
      { name: 'owner', refIds: [] },
      { name: 'team', refIds: [] },
      { name: 'lines', rows: [{ cells: [{ column: 'qty', value: '2' }] }] },
    ])
    // No file was uploaded: there is no draft to claim.
    expect(input['formDraftId']).toBeUndefined()
  })

  it('a cleared reference is sent empty, not with the node chosen before', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'search server' }))
    await user.click(await screen.findByRole('button', { name: 'pick web-01' }))
    await user.click(screen.getByRole('button', { name: 'clear server' }))
    expect(screen.queryByText('chosen web-01')).not.toBeInTheDocument()
    await submit(user)
    await waitFor(() => expect(apolloFinto.chiamata('CreateServiceRequest')).toBeDefined())
    expect(sentInput()['formAnswers']).toContainEqual({ name: 'server', refIds: [] })
  })

  it('a CI search passes the field types, its filter and the excluded CI types', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'search server' }))
    await screen.findByRole('button', { name: 'pick web-01' })
    const call = apolloFinto.query.mock.calls.at(-1)?.[0] as { variables: Record<string, unknown> }
    expect(call.variables).toEqual({ limit: 20, offset: 0, search: 'Web', ciTypes: ['server'], excludeCiTypes: ['firewall'], filters: '{"rules":[]}' })
  })

  it('a CI search without types, filter or known exclusions asks the whole CMDB', async () => {
    const { user } = setup({ excluded: null })
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'search anyci' }))
    await screen.findByRole('button', { name: 'pick web-01' })
    const call = apolloFinto.query.mock.calls.at(-1)?.[0] as { variables: Record<string, unknown> }
    expect(call.variables).toEqual({ limit: 20, offset: 0, search: 'Web' })
  })

  it('people are found by name or e-mail, teams by name, case-insensitively', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'search owner' }))
    expect(await screen.findByRole('button', { name: 'pick Web Admin' })).toBeInTheDocument()
    // No name: the e-mail is the label.
    expect(screen.getByRole('button', { name: 'pick web@x.io' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pick Zed' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'search team' }))
    expect(await screen.findByRole('button', { name: 'pick Web team' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pick DBA' })).not.toBeInTheDocument()
  })

  it('a search with no data offers nothing instead of failing', async () => {
    apolloFinto.query.mockImplementation(async () => ({ data: undefined }))
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    for (const f of ['server', 'owner', 'team']) {
      await user.click(screen.getByRole('button', { name: `search ${f}` }))
      expect(await screen.findByText(`${f}: no results`)).toBeInTheDocument()
    }
  })

  it('an uploaded file is listed and its draft goes with the request', async () => {
    upload.mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    expect(await screen.findByRole('button', { name: 'remove spec.pdf' })).toBeInTheDocument()
    await submit(user)
    await waitFor(() => expect(apolloFinto.chiamata('CreateServiceRequest')).toBeDefined())
    // The draft id is the one the file was uploaded to: that is how the server claims it.
    expect(sentInput()['formDraftId']).toBe(upload.mock.calls[0]?.[0])
  })

  it('switching item starts a new draft: the files and answers of the other item do not follow', async () => {
    upload.mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.type(screen.getByLabelText('kind'), 'yes')
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await screen.findByRole('button', { name: 'remove spec.pdf' })
    const firstDraft = upload.mock.calls[0]?.[0]
    await chooseItem(user, 'cat-2')
    await chooseItem(user, 'cat-1')
    expect(screen.queryByRole('button', { name: 'remove spec.pdf' })).not.toBeInTheDocument()
    expect(answers()).toEqual({})
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await screen.findByRole('button', { name: 'remove spec.pdf' })
    expect(upload.mock.calls[1]?.[0]).not.toBe(firstDraft)
  })

  it('a failed upload is said and nothing is listed', async () => {
    upload.mockRejectedValueOnce(new Error('too large')).mockRejectedValueOnce('offline')
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('too large'))
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('offline'))
    expect(screen.queryByRole('button', { name: /^remove/ })).not.toBeInTheDocument()
    expect(screen.queryByText('uploading')).not.toBeInTheDocument()
  })

  it('removing a file drops it only when the server confirms', async () => {
    upload.mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    const remove = await screen.findByRole('button', { name: 'remove spec.pdf' })
    // A refused delete (no data) keeps the file listed: it is still on the draft.
    apolloFinto.esiti['DeleteFormAttachment'] = {}
    await user.click(remove)
    expect(screen.getByRole('button', { name: 'remove spec.pdf' })).toBeInTheDocument()
    apolloFinto.esiti['DeleteFormAttachment'] = { data: { deleteAttachment: true } }
    await user.click(remove)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'remove spec.pdf' })).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('DeleteFormAttachment')).toEqual({ id: 'att-1' })
  })

  // Found in the tour of 23 Sep 2026, fixed: the removal awaited the mutation
  // with nothing to catch it, and Apollo 4 rejects a refusal after `onError`
  // has said why — every refused removal was also an «Uncaught (in promise)».
  it('a refused removal is said, keeps the file, and leaves no unhandled rejection behind', async () => {
    upload.mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
    await collectingUnhandledRejections(async (seen) => {
      const { user } = setup()
      await chooseItem(user, 'cat-1')
      await user.click(screen.getByRole('button', { name: 'upload doc' }))
      apolloFinto.esiti['DeleteFormAttachment'] = { error: new Error('The file is locked by another upload') }
      await user.click(await screen.findByRole('button', { name: 'remove spec.pdf' }))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('The file is locked by another upload'))
      expect(screen.getByRole('button', { name: 'remove spec.pdf' })).toBeInTheDocument()
      // Node reports an unhandled rejection at the end of the turn it happened in: one more turn is enough.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
    })
  })
})

describe('CreateServiceRequestPage — server rejections', () => {
  function rejection(extensions: Record<string, unknown>) {
    return Object.assign(new Error('Kind is not valid'), { errors: [{ message: 'Kind is not valid', extensions }] })
  }

  it('the field the server blames lights up; answering it again clears the mark; an upload clears its own', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    apolloFinto.esiti['CreateServiceRequest'] = { error: rejection({ i18n: { key: 'errors.x', params: { name: 'kind' } } }) }
    await submit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('kind: Kind is not valid')
    expect(toastError).toHaveBeenCalledWith('Kind is not valid')
    await user.type(screen.getByLabelText('kind'), 'a')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    apolloFinto.esiti['CreateServiceRequest'] = { error: rejection({ i18n: { key: 'errors.x', params: { name: 'doc' } } }) }
    await submit(user)
    expect(within(await screen.findByRole('alert')).getByText(/^doc:/)).toBeInTheDocument()
    upload.mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('a rejection without a field name marks nothing', async () => {
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    apolloFinto.esiti['CreateServiceRequest'] = { error: new Error('generic failure') }
    await submit(user)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('generic failure'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // Found in the tour of 23 Sep 2026, fixed: the submit awaited the creation
  // with nothing to catch it, and Apollo 4 rejects a refusal after `onError`
  // has said why — every refused request was also an «Uncaught (in promise)».
  it('a refused request leaves no unhandled rejection behind', async () => {
    await collectingUnhandledRejections(async (seen) => {
      const { user } = setup()
      await chooseItem(user, 'cat-1')
      apolloFinto.esiti['CreateServiceRequest'] = { error: new Error('generic failure') }
      await submit(user)
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('generic failure'))
      // Node reports an unhandled rejection at the end of the turn it happened in: one more turn is enough.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })

  it('a form republished while filling drops the old answers and reloads the form', async () => {
    upload.mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
    const { user } = setup()
    await chooseItem(user, 'cat-1')
    await user.type(screen.getByLabelText('kind'), 'yes')
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await screen.findByRole('button', { name: 'remove spec.pdf' })
    apolloFinto.refetch.mockClear()
    apolloFinto.esiti['CreateServiceRequest'] = { error: rejection({ i18n: { key: 'errors.catalogForm.revisionChanged', params: { name: 'kind' } } }) }
    await submit(user)
    await waitFor(() => expect(answers()).toEqual({}))
    // The answers belonged to another revision: no field stays marked, no file stays listed.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'remove spec.pdf' })).not.toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
