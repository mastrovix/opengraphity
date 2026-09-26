/**
 * KNOWLEDGE BASE ADMIN: where articles are written, sent for review and kept.
 *
 * What an editor relies on here, and what readers lose when it breaks:
 * - the list asks the API only for what `kbArticles` can filter on (status,
 *   category, title) and pages through it 20 at a time; a filter the API
 *   cannot honour is refused WITH ITS REASON, instead of a filter badge that
 *   silently changes nothing (E-03);
 * - an article is not saved without title, body and a category of the
 *   Dictionary, and an edit carries the version that was read, so a
 *   concurrent edit is refused instead of overwritten;
 * - «Submit for review» moves the draft to the step the WORKFLOW reaches from
 *   its initial step (G-9), not to the first step in the definition, and a
 *   refused move says why;
 * - the version history lists the old versions and a restored one comes back
 *   into the form.
 *
 * The rich text editor is a stand-in textarea: it has its own concerns
 * (Markdown ⇄ HTML), this file is about what the page does with the text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { KBAdminPage } from './KBAdminPage'

// The fake Apollo answers "loaded" and "not saving"; these names are held in flight.
const inFlight = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  return {
    ...m,
    useQuery: (...args: Parameters<typeof m.useQuery>) => {
      const r = m.useQuery(...args)
      return inFlight.has(nomeOperazione(args[0])) ? { ...r, data: undefined, loading: true } : r
    },
    useMutation: (...args: Parameters<typeof m.useMutation>) => {
      const [fn, r] = m.useMutation(...args)
      return [fn, inFlight.has(nomeOperazione(args[0])) ? { ...r, loading: true } : r]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/components/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange, placeholder }: { value: string; onChange: (markdown: string) => void; placeholder?: string }) => (
    <textarea aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface Article {
  id: string; title: string; slug: string; body: string; category: string; tags: string[]
  status: string; authorName: string; views: number; helpfulCount: number
  createdAt: string; updatedAt: string; publishedAt: string | null
  workflowInstanceId: string | null; currentStep: string | null; version: number
}

const article = (over: Partial<Article> = {}): Article => ({
  id: 'kb-1', title: 'Reset the VPN client', slug: 'reset-the-vpn-client', body: 'Open the client and press **Reset**.',
  category: 'network', tags: ['vpn', 'windows'], status: 'draft', authorName: 'Ada Lovelace', views: 42, helpfulCount: 3,
  createdAt: '2026-08-01T08:00:00Z', updatedAt: '2026-09-01T08:30:00Z', publishedAt: null,
  workflowInstanceId: 'wi-1', currentStep: 'draft', version: 3, ...over,
})

const step = (name: string, label: string, over: Record<string, unknown> = {}) => ({
  id: `st-${name}`, name, label, labels: [], type: 'standard', isInitial: false, isTerminal: false, isOpen: true,
  category: null, purpose: null, order: 0, ...over,
})

const STEPS = [
  step('draft', 'Draft', { isInitial: true, order: 1 }),
  // Not reachable from the draft, and BEFORE review in the definition (G-9). No label: shown by its name.
  step('on_hold', '', { category: 'waiting', order: 2 }),
  step('rejected', 'Rejected', { isTerminal: true, isOpen: false, category: 'closed', order: 3 }),
  step('review', 'In review', { category: 'waiting', order: 4 }),
  step('published', 'Published', { category: 'published', order: 5 }),
]
// From the draft one can go to "rejected" (terminal) or to "review".
const TRANSITIONS = [
  { id: 'tr-1', fromStepName: 'draft', toStepName: 'rejected', trigger: 'manual' },
  { id: 'tr-2', fromStepName: 'draft', toStepName: 'review', trigger: 'manual' },
  { id: 'tr-3', fromStepName: 'review', toStepName: 'published', trigger: 'manual' },
]

const KB_CATEGORIES = [
  { value: 'network', label: 'Network', labels: [] },
  { value: 'access', label: 'Access', labels: [] },
]
const vocabulary: DomainVocabularies = {
  valuesOf: (n) => (n === 'kb_category' ? KB_CATEGORIES.map((c) => c.value) : null),
  entriesOf: (n) => (n === 'kb_category' ? KB_CATEGORIES : null),
  labelOf: (n, v) => (n === 'kb_category' ? KB_CATEGORIES.find((c) => c.value === v)?.label ?? null : null),
  colorOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}

const list = (items: Article[], total = items.length) => {
  apolloFinto.risposte['AdminKBArticles'] = { kbArticles: { items, total } }
}
const transitionOk = { data: { executeWorkflowTransition: { success: true, error: null, errorKey: null, errorParams: null } } }
const saved = (over: Partial<Article> = {}) => ({ data: { updateKBArticle: article({ version: 4, ...over }) } })

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: STEPS, transitions: TRANSITIONS } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [] }
  apolloFinto.risposte['KBArticleVersions'] = { kbArticleVersions: [] }
  list([])
})

// ── Helpers ──────────────────────────────────────────────────────────────────

type User = ReturnType<typeof renderWithProviders>['user']

const mount = (route = '/admin/kb', vocab: DomainVocabularies = vocabulary) => renderWithProviders(
  <DomainVocabularyContext.Provider value={vocab}><KBAdminPage /></DomainVocabularyContext.Provider>,
  { route },
)
const lastListCall = () => apolloFinto.chiamata('AdminKBArticles')
const rowOf = (title: string) => within(screen.getByRole('table', { name: 'Knowledge Base articles' })).getByText(title).closest('tr')!
const titleField = () => screen.getByLabelText('Title *')
const categoryField = () => screen.getByLabelText('Category *')
const tagsField = () => screen.getByLabelText('Tags (comma separated)')
const bodyField = () => screen.getByLabelText('Write the body of the article...')
const saveButton = () => screen.getByRole('button', { name: 'Save' })
const submitButton = () => screen.getByRole('button', { name: 'Submit for review' })
const formHeading = (name: 'New article' | 'Edit article') => screen.queryByRole('heading', { name })

async function openEdit(user: User, title = 'Reset the VPN client') {
  await user.click(within(rowOf(title)).getByRole('button', { name: 'Edit' }))
  expect(formHeading('Edit article')).toBeInTheDocument()
}

interface Rule { field: string; operator?: string; value?: string }
async function applyFilters(user: User, rules: Rule[], connector?: 'OR') {
  await user.click(screen.getByRole('button', { name: 'Advanced filters' }))
  for (const [i, rule] of rules.entries()) {
    const n = i + 1
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByLabelText(`Field of condition ${n}`), rule.field)
    if (rule.operator) await user.selectOptions(screen.getByLabelText(`Operator of condition ${n}`), rule.operator)
    if (rule.value === undefined) continue
    const value = screen.getByLabelText(`Value of condition ${n}`)
    if (value instanceof HTMLSelectElement) await user.selectOptions(value, rule.value)
    else await user.type(value, rule.value)
  }
  if (connector) await user.click(screen.getByRole('button', { name: connector }))
  await user.click(screen.getByRole('button', { name: 'Apply' }))
}

// ── List ─────────────────────────────────────────────────────────────────────

describe('the list of articles', () => {
  it('counts the articles and shows, per row, category, step, author, views and last update', () => {
    list([
      article(),
      // A category the Dictionary no longer has and a step no workflow declares: shown as stored, not hidden.
      article({ id: 'kb-2', title: 'Old printer guide', category: 'printers', status: 'legacy_state', authorName: 'Bob', views: 0 }),
    ])
    mount()
    expect(screen.getByText('2 articles')).toBeInTheDocument()
    const first = rowOf('Reset the VPN client')
    expect(within(first).getByText('Network')).toBeInTheDocument()
    expect(within(first).getByText('Draft')).toBeInTheDocument()
    expect(within(first).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(first).getByText('42')).toBeInTheDocument()
    expect(within(first).getByText('01 Sept 2026')).toBeInTheDocument()
    const second = rowOf('Old printer guide')
    expect(within(second).getByText('printers')).toBeInTheDocument()
    expect(within(second).getByText('legacy_state')).toBeInTheDocument()
  })

  it('the status badge carries the icon of the step category (published, closed, waiting) and none otherwise', () => {
    list([
      article({ id: 'a', title: 'A', status: 'published' }),
      article({ id: 'b', title: 'B', status: 'rejected' }),
      article({ id: 'c', title: 'C', status: 'review' }),
      article({ id: 'd', title: 'D', status: 'draft' }),
      article({ id: 'e', title: 'E', status: 'on_hold' }),
    ])
    mount()
    const badge = (title: string, label: string) => within(rowOf(title)).getByText(label)
    expect(badge('A', 'Published').querySelector('svg')).not.toBeNull()
    expect(badge('B', 'Rejected').querySelector('svg')).not.toBeNull()
    expect(badge('C', 'In review').querySelector('svg')).not.toBeNull()
    expect(badge('D', 'Draft').querySelector('svg')).toBeNull()
    // A step with no label is read by its name.
    expect(badge('E', 'on_hold').querySelector('svg')).not.toBeNull()
  })

  it('with no article, says so and counts zero', () => {
    mount()
    expect(screen.getByText('No articles')).toBeInTheDocument()
    expect(screen.getByText('0 articles')).toBeInTheDocument()
  })

  it('while the list loads, the count is a dash, not "0 articles"', () => {
    inFlight.add('AdminKBArticles')
    mount()
    expect(screen.queryByText('0 articles')).toBeNull()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('pages of 20: Next asks the API for the next page, Prev comes back', async () => {
    list([article()], 45)
    const { user } = mount()
    expect(lastListCall()).toEqual({ page: 1, pageSize: 20, status: null, category: null, search: null, sortField: null, sortDirection: null })
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastListCall()).toEqual({ page: 2, pageSize: 20, status: null, category: null, search: null, sortField: null, sortDirection: null })
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(lastListCall()).toMatchObject({ page: 1 })
  })
})

// ── Filters ──────────────────────────────────────────────────────────────────

describe('sorting the articles (26 Sep 2026: every column sorts)', () => {
  it('a column asks the server to sort the whole list, from page 1', async () => {
    list([article()], 45)
    const { user } = mount()
    await user.click(within(screen.getByRole('columnheader', { name: /Title/ })).getByRole('button'))
    expect(lastListCall()).toMatchObject({ page: 1, sortField: 'title', sortDirection: 'asc' })
  })
})

describe('the filters the API can honour', () => {
  it('offers the steps of the workflow and the categories of the Dictionary', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    const fieldSelect = screen.getByLabelText('Field of condition 1')
    expect(within(fieldSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select field...', 'Status', 'Category', 'Title'])
    await user.selectOptions(fieldSelect, 'status')
    expect(within(screen.getByLabelText('Value of condition 1')).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Select', 'Draft', 'on_hold', 'Rejected', 'In review', 'Published'])
    await user.selectOptions(fieldSelect, 'category')
    expect(within(screen.getByLabelText('Value of condition 1')).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Select', 'Network', 'Access'])
  })

  it('status, category and title become the arguments of the search, trimmed, from the first page', async () => {
    list([article()], 45)
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await applyFilters(user, [
      { field: 'status', value: 'review' },
      { field: 'category', value: 'network' },
      { field: 'title', value: '  vpn  ' },
    ])
    expect(lastListCall()).toEqual({ page: 1, pageSize: 20, status: 'review', category: 'network', search: 'vpn', sortField: null, sortDirection: null })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('Reset gives the whole list back', async () => {
    const { user } = mount()
    await applyFilters(user, [{ field: 'category', value: 'access' }])
    expect(lastListCall()).toMatchObject({ category: 'access' })
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(lastListCall()).toMatchObject({ status: null, category: null, search: null })
  })

  it.each<{ what: string; rules: Rule[]; connector?: 'OR'; message: string }>([
    { what: 'conditions joined by OR', rules: [{ field: 'status', value: 'review' }, { field: 'category', value: 'network' }], connector: 'OR',
      message: 'Article search only supports conditions joined with AND' },
    { what: 'a status that is not "equals"', rules: [{ field: 'status', operator: 'not_equals', value: 'review' }],
      message: 'The "Status" filter only supports "equals"' },
    { what: 'the same field twice', rules: [{ field: 'category', value: 'network' }, { field: 'category', value: 'access' }],
      message: 'The "Category" filter can appear only once' },
    { what: 'a title that is not "contains"', rules: [{ field: 'title', operator: 'starts_with', value: 'vpn' }],
      message: 'The "Title" filter only supports "contains"' },
    { what: 'the title twice', rules: [{ field: 'title', value: 'vpn' }, { field: 'title', value: 'mail' }],
      message: 'The "Title" filter can appear only once' },
    { what: 'a title made of spaces', rules: [{ field: 'title', value: '   ' }],
      message: 'Missing value for the "Title" filter' },
    { what: 'a status with no value to compare ("is empty")', rules: [{ field: 'status', operator: 'is_empty' }],
      message: 'Missing value for the "Status" filter' },
    // Fixed on 23 Sep 2026: the reason named the field by its key («"category"»), which the Italian page could not translate.
  ])('refuses $what, says why with the field as the filter names it, and leaves the search as it was', async ({ rules, connector, message }) => {
    const { user } = mount()
    await applyFilters(user, rules, connector)
    expect(toast.error).toHaveBeenCalledWith(message)
    expect(lastListCall()).toEqual({ page: 1, pageSize: 20, status: null, category: null, search: null, sortField: null, sortDirection: null })
  })
})

// ── Writing a new article ────────────────────────────────────────────────────

describe('writing a new article', () => {
  async function openNew(user: User) {
    await user.click(screen.getByRole('button', { name: 'New article' }))
    expect(formHeading('New article')).toBeInTheDocument()
  }

  it('the form opens from the button, and straight away from a link with ?new=1', async () => {
    const { user, unmount } = mount()
    expect(formHeading('New article')).toBeNull()
    await openNew(user)
    unmount()
    mount('/admin/kb?new=1')
    expect(formHeading('New article')).toBeInTheDocument()
    // A new article has no history and nothing to submit yet.
    expect(screen.queryByRole('heading', { name: 'Version history' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull()
  })

  it('refuses to save without title and body, then without a category', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(titleField(), '   ')
    await user.click(saveButton())
    expect(toast.error).toHaveBeenLastCalledWith('Title and body are required')
    await user.type(titleField(), 'Reset the VPN client')
    await user.type(bodyField(), 'Open the client.')
    await user.click(saveButton())
    expect(toast.error).toHaveBeenLastCalledWith('Choose a category for the article.')
    expect(apolloFinto.chiamate['CreateKBArticle']).toBeUndefined()
  })

  it('creates the article with its tags split on commas, then closes the form and reloads the list', async () => {
    apolloFinto.esiti['CreateKBArticle'] = { data: { createKBArticle: { id: 'kb-9', title: 'x', slug: 'x', status: 'draft', workflowInstanceId: 'wi-9', currentStep: 'draft' } } }
    const { user } = mount()
    await openNew(user)
    // The category is chosen from the Dictionary: nothing is preselected.
    expect(categoryField()).toHaveValue('')
    expect(within(categoryField()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a category', 'Network', 'Access'])
    await user.type(titleField(), 'Reset the VPN client')
    await user.selectOptions(categoryField(), 'access')
    await user.type(tagsField(), 'vpn, , windows ,')
    expect(screen.getByText('0 / 50000 characters')).toBeInTheDocument()
    await user.type(bodyField(), 'Hello')
    expect(screen.getByText('5 / 50000 characters')).toBeInTheDocument()
    await user.click(saveButton())
    // A new article is for the staff until its author says otherwise (24 Sep 2026).
    expect(apolloFinto.chiamata('CreateKBArticle')).toEqual({ title: 'Reset the VPN client', body: 'Hello', category: 'access', tags: ['vpn', 'windows'], audience: 'staff' })
    expect(toast.success).toHaveBeenCalledWith('Article created')
    await waitFor(() => expect(formHeading('New article')).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // Saving is not submitting: nothing is sent for review.
    expect(apolloFinto.chiamate['KBTransition']).toBeUndefined()
  })

  it('the author chooses who the article is for: everyone puts it on the portal', async () => {
    apolloFinto.esiti['CreateKBArticle'] = { data: { createKBArticle: { id: 'kb-9', title: 'x', slug: 'x', status: 'draft', workflowInstanceId: 'wi-9', currentStep: 'draft' } } }
    const { user } = mount()
    await openNew(user)
    const audience = screen.getByLabelText('Audience')
    expect(audience).toHaveValue('staff')
    expect(within(audience).getAllByRole('option').map((o) => o.textContent)).toEqual(['Staff only', 'Everyone (portal too)'])
    await user.type(titleField(), 'Connect to the Wi-Fi')
    await user.selectOptions(categoryField(), 'access')
    await user.selectOptions(audience, 'everyone')
    await user.type(bodyField(), 'Pick the network.')
    await user.click(saveButton())
    expect(apolloFinto.chiamata('CreateKBArticle')).toMatchObject({ audience: 'everyone' })
  })

  it('a refused creation keeps the form and what was typed, and shows the error', async () => {
    apolloFinto.esiti['CreateKBArticle'] = { error: new Error('category not allowed') }
    const { user } = mount()
    await openNew(user)
    await user.type(titleField(), 'Reset the VPN client')
    await user.type(bodyField(), 'Body')
    await user.selectOptions(categoryField(), 'network')
    await user.click(saveButton())
    expect(toast.error).toHaveBeenCalledWith('category not allowed')
    expect(formHeading('New article')).toBeInTheDocument()
    expect(titleField()).toHaveValue('Reset the VPN client')
  })

  it('while saving, Save says so and cannot be pressed twice', () => {
    inFlight.add('CreateKBArticle')
    mount('/admin/kb?new=1')
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled()
  })

  it('when the Dictionary cannot be read, no category is invented and saving asks for one', async () => {
    const unread: DomainVocabularies = { ...vocabulary, entriesOf: () => null, labelOf: () => null, valuesOf: () => null }
    const { user } = mount('/admin/kb?new=1', unread)
    expect(within(categoryField()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a category'])
    await user.type(titleField(), 'Reset the VPN client')
    await user.type(bodyField(), 'Body')
    await user.click(saveButton())
    expect(toast.error).toHaveBeenCalledWith('Choose a category for the article.')
    expect(apolloFinto.chiamate['CreateKBArticle']).toBeUndefined()
  })

  it('a form opened by ?new=1 leaves the address once saved: a reload does not open an empty form again (G10)', async () => {
    apolloFinto.esiti['CreateKBArticle'] = { data: { createKBArticle: { id: 'kb-9', title: 'x', slug: 'x', status: 'draft', workflowInstanceId: 'wi-9', currentStep: 'draft' } } }
    const { user } = mount('/admin/kb?new=1')
    await user.type(titleField(), 'Reset the VPN client')
    await user.selectOptions(categoryField(), 'access')
    await user.type(bodyField(), 'Body')
    await user.click(saveButton())
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/kb$/))
  })

  it('the title in the list opens the article, as the pencil does (G10)', async () => {
    list([article()])
    const { user } = mount()
    const row = rowOf('Reset the VPN client')
    await user.click(within(row).getByRole('button', { name: 'Reset the VPN client' }))
    expect(formHeading('Edit article')).toBeInTheDocument()
    expect(titleField()).toHaveValue('Reset the VPN client')
  })

  it('Cancel closes the form without saving', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(titleField(), 'Draft idea')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(formHeading('New article')).toBeNull()
    expect(apolloFinto.chiamate['CreateKBArticle']).toBeUndefined()
  })

  it('"New article" while editing starts from an empty form', async () => {
    list([article()])
    const { user } = mount()
    await openEdit(user)
    await openNew(user)
    expect(titleField()).toHaveValue('')
    expect(tagsField()).toHaveValue('')
    expect(bodyField()).toHaveValue('')
  })
})

// ── Editing ──────────────────────────────────────────────────────────────────

describe('editing an article', () => {
  it('Edit fills the form with the article; Save sends the version that was read', async () => {
    list([article({ status: 'published' })])
    apolloFinto.esiti['UpdateKBArticle'] = saved({ status: 'published' })
    const { user } = mount()
    await openEdit(user)
    expect(titleField()).toHaveValue('Reset the VPN client')
    expect(categoryField()).toHaveValue('network')
    expect(tagsField()).toHaveValue('vpn, windows')
    expect(bodyField()).toHaveValue('Open the client and press **Reset**.')
    // A published article is neither "waiting for approval" nor submittable again.
    expect(screen.queryByText(/Waiting for approval/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull()
    await user.clear(titleField())
    await user.type(titleField(), 'Reset the VPN client (Windows)')
    await user.click(saveButton())
    expect(apolloFinto.chiamata('UpdateKBArticle')).toEqual({
      id: 'kb-1', title: 'Reset the VPN client (Windows)', body: 'Open the client and press **Reset**.',
      category: 'network', tags: ['vpn', 'windows'], expectedVersion: 3,
    })
    expect(toast.success).toHaveBeenCalledWith('Article updated')
    await waitFor(() => expect(formHeading('Edit article')).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a category no longer in the Dictionary stays selected and visible, instead of vanishing from the field', async () => {
    list([article({ category: 'printers' })])
    const { user } = mount()
    await openEdit(user)
    expect(categoryField()).toHaveValue('printers')
    expect(within(categoryField()).getByRole('option', { name: 'printers' })).toBeInTheDocument()
  })

  it('an update refused because someone else saved first keeps the form open with the reason', async () => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = { error: new Error('KBArticle kb-1 was modified by someone else') }
    const { user } = mount()
    await openEdit(user)
    await user.click(saveButton())
    expect(toast.error).toHaveBeenCalledWith('KBArticle kb-1 was modified by someone else')
    expect(formHeading('Edit article')).toBeInTheDocument()
  })

  it('an article in review points to the Approvals page and cannot be submitted again', async () => {
    list([article({ status: 'review' })])
    const { user } = mount()
    await openEdit(user)
    expect(screen.getByText(/Waiting for approval before publication:/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'open Approvals' })).toHaveAttribute('href', '/approvals')
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull()
  })
})

// ── Submit for review ────────────────────────────────────────────────────────

describe('submit for review', () => {
  it('saves, then moves the draft to the step the workflow reaches from the initial one', async () => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    apolloFinto.esiti['KBTransition'] = transitionOk
    const { user } = mount()
    await openEdit(user)
    expect(screen.getByText(/"Save" updates the content without changing the status/)).toBeInTheDocument()
    await user.click(submitButton())
    expect(apolloFinto.chiamata('UpdateKBArticle')).toMatchObject({ id: 'kb-1', expectedVersion: 3 })
    // Not "on_hold" (first in the definition), not the terminal "rejected": the arcs decide (G-9).
    expect(apolloFinto.chiamata('KBTransition')).toEqual({ instanceId: 'wi-1', toStep: 'review' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Article sent for review'))
    expect(formHeading('Edit article')).toBeNull()
    expect(toast.success).not.toHaveBeenCalledWith('Article updated')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('while the draft is being saved, neither Save nor Submit can be pressed again', async () => {
    list([article()])
    inFlight.add('UpdateKBArticle')
    const { user } = mount()
    await openEdit(user)
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled()
    expect(submitButton()).toBeDisabled()
  })

  it('uses the workflow instance of the article when the save response does not carry one', async () => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = saved({ workflowInstanceId: null })
    apolloFinto.esiti['KBTransition'] = transitionOk
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    expect(apolloFinto.chiamata('KBTransition')).toEqual({ instanceId: 'wi-1', toStep: 'review' })
  })

  it('refuses an empty title or body, then a missing category, before saving anything', async () => {
    list([article({ category: '' })])
    const { user } = mount()
    await openEdit(user)
    await user.clear(titleField())
    await user.click(submitButton())
    expect(toast.error).toHaveBeenLastCalledWith('Title and body are required before publishing')
    await user.type(titleField(), 'Reset the VPN client')
    await user.click(submitButton())
    expect(toast.error).toHaveBeenLastCalledWith('Choose a category for the article.')
    expect(apolloFinto.chiamate['UpdateKBArticle']).toBeUndefined()
  })

  it.each([
    { what: 'a reason the client can translate', result: { success: false, error: 'Concurrent transition', errorKey: 'errors.workflow.concurrentTransition', errorParams: [] },
      message: 'Someone else moved this ticket in the meantime: reload the page and try again.' },
    { what: 'only the sentence of the server', result: { success: false, error: 'Step review is locked', errorKey: 'errors.not.a.key', errorParams: null },
      message: 'Step review is locked' },
    { what: 'no reason at all', result: { success: false, error: null, errorKey: null, errorParams: null },
      message: 'The article was saved but could not be sent for review.' },
  ])('a move refused with $what says so and keeps the form open', async ({ result, message }) => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    apolloFinto.esiti['KBTransition'] = { data: { executeWorkflowTransition: result } }
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
    expect(formHeading('Edit article')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a move that fails outright shows the error and keeps the form open', async () => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    apolloFinto.esiti['KBTransition'] = { error: new Error('workflow engine unreachable') }
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('workflow engine unreachable'))
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(formHeading('Edit article')).toBeInTheDocument()
  })

  it('an article with no workflow instance cannot be moved, and it is said', async () => {
    list([article({ workflowInstanceId: null })])
    apolloFinto.esiti['UpdateKBArticle'] = saved({ workflowInstanceId: null })
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    expect(toast.error).toHaveBeenCalledWith('WorkflowInstance or review step not found')
    expect(apolloFinto.chiamate['KBTransition']).toBeUndefined()
  })

  it('a workflow that goes nowhere from the draft: the same message, nothing moved', async () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: STEPS, transitions: [TRANSITIONS[0]] } }
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    expect(toast.error).toHaveBeenCalledWith('WorkflowInstance or review step not found')
    expect(apolloFinto.chiamate['KBTransition']).toBeUndefined()
  })

  it('a submit whose save is refused does not turn the next plain Save into a submission', async () => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = { error: new Error('body too long') }
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    expect(toast.error).toHaveBeenCalledWith('body too long')
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    await user.click(saveButton())
    expect(toast.success).toHaveBeenCalledWith('Article updated')
    expect(apolloFinto.chiamate['KBTransition']).toBeUndefined()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the save that precedes the move bumps the
  // article's version (3 → 4); when the move is refused the form stays open, and it used to keep the
  // version it read on opening — the next «Submit for review» sent `expectedVersion: 3` and the API
  // refused the editor's own article as "modified by someone else".
  it('after a refused move, submitting again sends the version the first save produced', async () => {
    list([article()])
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    apolloFinto.esiti['KBTransition'] = { data: { executeWorkflowTransition: { success: false, error: 'locked', errorKey: null, errorParams: null } } }
    const { user } = mount()
    await openEdit(user)
    await user.click(submitButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('locked'))
    await user.click(submitButton())
    expect(apolloFinto.chiamata('UpdateKBArticle')).toMatchObject({ expectedVersion: 4 })
  })
})

// ── Version history ──────────────────────────────────────────────────────────

describe('version history', () => {
  const VERSIONS = [
    { version: 2, title: 'Reset VPN', category: 'network', tags: [], editedByName: 'Bob Editor', editedAt: '2026-09-01T08:30:00Z' },
    { version: 1, title: 'VPN', category: 'network', tags: [], editedByName: null, editedAt: '2026-08-20T07:00:00Z' },
  ]
  const versionRow = (v: string) => screen.getByText(v).closest('tr')!
  const RESTORED = { data: { restoreKBArticleVersion: { id: 'kb-1', title: 'VPN', body: 'Old body', category: 'access', tags: ['legacy', 'vpn'], version: 4 } } }

  it('lists the earlier versions of the article being edited, with who and when', async () => {
    list([article()])
    apolloFinto.risposte['KBArticleVersions'] = { kbArticleVersions: VERSIONS }
    const { user } = mount()
    await openEdit(user)
    expect(screen.getByRole('heading', { name: 'Version history' })).toBeInTheDocument()
    expect(apolloFinto.chiamata('KBArticleVersions')).toEqual({ articleId: 'kb-1' })
    expect(within(versionRow('v2')).getByText('Reset VPN')).toBeInTheDocument()
    expect(within(versionRow('v2')).getByText('Bob Editor')).toBeInTheDocument()
    expect(within(versionRow('v2')).getByText('01 Sept 2026, 10:30')).toBeInTheDocument()
    // Nobody recorded as editor: a dash, not "null".
    expect(within(versionRow('v1')).getByText('—')).toBeInTheDocument()
  })

  it('Restore puts that version back in the form and says so', async () => {
    list([article()])
    apolloFinto.risposte['KBArticleVersions'] = { kbArticleVersions: VERSIONS }
    apolloFinto.esiti['RestoreKBArticleVersion'] = RESTORED
    const { user } = mount()
    await openEdit(user)
    await user.click(within(versionRow('v1')).getByRole('button', { name: 'Restore' }))
    expect(apolloFinto.chiamata('RestoreKBArticleVersion')).toEqual({ articleId: 'kb-1', version: 1 })
    expect(toast.success).toHaveBeenCalledWith('Version restored')
    expect(titleField()).toHaveValue('VPN')
    expect(bodyField()).toHaveValue('Old body')
    expect(categoryField()).toHaveValue('access')
    expect(tagsField()).toHaveValue('legacy, vpn')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the API restores a version THROUGH
  // updateKBArticle, which bumps the article's version (3 → 4). The page put the restored text in the
  // form but kept the version it read on opening, so the next Save sent `expectedVersion: 3` and the
  // API refused the editor's own restore as "modified by someone else".
  it('after a restore, Save sends the version the restore produced', async () => {
    list([article()])
    apolloFinto.risposte['KBArticleVersions'] = { kbArticleVersions: VERSIONS }
    apolloFinto.esiti['RestoreKBArticleVersion'] = RESTORED
    apolloFinto.esiti['UpdateKBArticle'] = saved()
    const { user } = mount()
    await openEdit(user)
    await user.click(within(versionRow('v1')).getByRole('button', { name: 'Restore' }))
    await user.click(saveButton())
    expect(apolloFinto.chiamata('UpdateKBArticle')).toMatchObject({ expectedVersion: 4 })
  })

  it('a refused restore shows the error and leaves the form as it was', async () => {
    list([article()])
    apolloFinto.risposte['KBArticleVersions'] = { kbArticleVersions: VERSIONS }
    apolloFinto.esiti['RestoreKBArticleVersion'] = { error: new Error('Version 1 not found for article') }
    const { user } = mount()
    await openEdit(user)
    await user.click(within(versionRow('v1')).getByRole('button', { name: 'Restore' }))
    expect(toast.error).toHaveBeenCalledWith('Version 1 not found for article')
    expect(titleField()).toHaveValue('Reset the VPN client')
  })

  it('while a restore runs, no other Restore can be pressed', async () => {
    list([article()])
    apolloFinto.risposte['KBArticleVersions'] = { kbArticleVersions: VERSIONS }
    inFlight.add('RestoreKBArticleVersion')
    const { user } = mount()
    await openEdit(user)
    for (const b of screen.getAllByRole('button', { name: 'Restore' })) expect(b).toBeDisabled()
  })

  it('an article never edited has no history yet, and says so', async () => {
    list([article()])
    const { user } = mount()
    await openEdit(user)
    expect(screen.getByText('No previous version. Future edits will build the history.')).toBeInTheDocument()
  })

  it('while the history loads, says so', async () => {
    list([article()])
    inFlight.add('KBArticleVersions')
    const { user } = mount()
    await openEdit(user)
    expect(screen.getByText('Loading the history...')).toBeInTheDocument()
  })
})

// ── Delete ───────────────────────────────────────────────────────────────────

describe('deleting an article', () => {
  it('the bin asks to confirm in the row; Confirm deletes and reloads', async () => {
    list([article()])
    const { user } = mount()
    await user.click(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Delete' }))
    await user.click(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Confirm' }))
    expect(apolloFinto.chiamata('DeleteKBArticle')).toEqual({ id: 'kb-1' })
    expect(toast.success).toHaveBeenCalledWith('Article deleted')
    expect(within(rowOf('Reset the VPN client')).queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('Cancel keeps the article', async () => {
    list([article()])
    const { user } = mount()
    await user.click(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Delete' }))
    await user.click(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Cancel' }))
    expect(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(apolloFinto.chiamate['DeleteKBArticle']).toBeUndefined()
  })

  it('a refused delete shows the error', async () => {
    list([article()])
    apolloFinto.esiti['DeleteKBArticle'] = { error: new Error('article has feedback') }
    const { user } = mount()
    await user.click(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Delete' }))
    await user.click(within(rowOf('Reset the VPN client')).getByRole('button', { name: 'Confirm' }))
    expect(toast.error).toHaveBeenCalledWith('article has feedback')
    expect(toast.success).not.toHaveBeenCalled()
  })
})
