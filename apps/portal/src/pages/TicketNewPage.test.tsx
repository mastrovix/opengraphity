import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { GET_FIELD_VISIBILITY_RULES, GET_FIELD_REQUIREMENT_RULES } from '@opengraphity/web-core'
import { TicketNewPage } from './TicketNewPage'
import { CREATE_TICKET } from '@/graphql/mutations'
import { GET_KB_ARTICLES, GET_TICKET_CATEGORIES, GET_PORTAL_SEVERITY_CHOICES } from '@/graphql/queries'
import { uploadAttachment } from '@/lib/attachments'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('@/lib/attachments', () => ({
  uploadAttachment:   vi.fn(async () => {}),
  downloadAttachment: vi.fn(async () => {}),
}))

/** Regole campo: registra l'entityType con cui vengono richieste. */
function rulesMocks(seen: { visibility: unknown[]; requirement: unknown[] }, opts: { required?: string[]; error?: string } = {}): GqlMock[] {
  return [
    {
      request: { query: GET_FIELD_VISIBILITY_RULES, variables: (v) => { seen.visibility.push(v); return true } },
      ...(opts.error ? { error: new Error(opts.error) } : { result: { data: { fieldVisibilityRules: [] } } }),
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
    {
      request: { query: GET_FIELD_REQUIREMENT_RULES, variables: (v) => { seen.requirement.push(v); return true } },
      result: { data: { fieldRequirementRules: (opts.required ?? []).map((f) => ({ __typename: 'FieldRequirementRule', id: `r-${f}`, entityType: 'incident', fieldName: f, required: true, workflowStep: null })) } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
  ]
}

const kbMock: GqlMock = {
  request: { query: GET_KB_ARTICLES, variables: () => true },
  result: { data: { kbArticles: { __typename: 'KBArticlePage', items: [], total: 0 } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

function createTicketMock(vars: Record<string, unknown>, seen?: unknown[]): GqlMock {
  return {
    request: { query: CREATE_TICKET, variables: (v) => { seen?.push(v); return JSON.stringify(v) === JSON.stringify(vars) } },
    result: { data: { createTicket: {
      __typename: 'Ticket', id: 'tk-1', type: 'incident', title: vars['title'], description: vars['description'] ?? null,
      status: 'new', priority: vars['priority'], priorityLabel: String(vars['priority']), priorityColor: null, category: vars['category'], createdAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z', assignedTeam: null,
    } } },
  }
}

const categoriesMock: GqlMock = {
  request: { query: GET_TICKET_CATEGORIES, variables: () => true },
  result: { data: { ticketCategories: ['hardware', 'software', 'access', 'network', 'security', 'other'].map((name) => ({ __typename: 'TicketCategory', name, label: name[0]!.toUpperCase() + name.slice(1) })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

/**
 * Le severità che l'amministratore offre nel portale, con le SUE parole
 * (verifica «Cosa resta cablato», ondata 1): `blocker` è un valore del cliente.
 */
const severityMock: GqlMock = {
  request: { query: GET_PORTAL_SEVERITY_CHOICES, variables: () => true },
  result: { data: { portalSeverityChoices: [
    { __typename: 'PortalSeverityChoice', value: 'blocker', label: 'It stops my work', color: 'danger' },
    { __typename: 'PortalSeverityChoice', value: 'medium', label: 'Medium', color: null },
    { __typename: 'PortalSeverityChoice', value: 'low', label: 'It can wait', color: null },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const ROUTE = { route: '/tickets/new', path: '/tickets/new' }

async function fillForm(user: ReturnType<typeof renderWithProviders>['user'], opts: { priority?: string } = {}) {
  await user.click(await screen.findByRole('button', { name: 'Hardware' }))
  await user.type(screen.getByPlaceholderText('Describe the problem in one sentence'), 'Printer broken')
  await user.type(screen.getByPlaceholderText(/Provide all useful details/), 'Details here')
  await user.click(await screen.findByRole('radio', { name: opts.priority ?? 'Medium' }))
}

beforeEach(() => { vi.mocked(uploadAttachment).mockClear() })

describe('TicketNewPage', () => {
  it('chiede le regole campo per "incident" (le stesse della CreateIncidentPage web)', async () => {
    const seen = { visibility: [] as unknown[], requirement: [] as unknown[] }
    renderWithProviders(<TicketNewPage />, { ...ROUTE, mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock] })
    await waitFor(() => expect(seen.visibility.length).toBeGreaterThan(0))
    await waitFor(() => expect(seen.requirement.length).toBeGreaterThan(0))
    expect(seen.visibility[0]).toEqual({ entityType: 'incident' })
    expect(seen.requirement[0]).toEqual({ entityType: 'incident', workflowStep: null })
  })

  it('Submit è disabilitato finché mancano categoria, titolo, descrizione o severità', async () => {
    const seen = { visibility: [], requirement: [] }
    const { user } = renderWithProviders(<TicketNewPage />, { ...ROUTE, mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock] })
    const submit = screen.getByRole('button', { name: 'Submit ticket' })
    expect(submit).toBeDisabled()
    await user.click(await screen.findByRole('button', { name: 'Software' }))
    await user.type(screen.getByPlaceholderText('Describe the problem in one sentence'), 'Titolo')
    expect(submit).toBeDisabled()
    await user.type(screen.getByPlaceholderText(/Provide all useful details/), 'Descrizione')
    expect(submit).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: 'It can wait' }))
    expect(submit).toBeEnabled()
  })

  it('submit → createTicket con titolo, descrizione, priorità e categoria, poi naviga al ticket', async () => {
    const seen = { visibility: [], requirement: [] }
    const created: unknown[] = []
    const { user } = renderWithProviders(<TicketNewPage />, {
      ...ROUTE,
      mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock, createTicketMock({ title: 'Printer broken', description: 'Details here', priority: 'blocker', category: 'hardware' }, created)],
    })
    await fillForm(user, { priority: 'It stops my work' })
    await user.click(screen.getByRole('button', { name: 'Submit ticket' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tickets/tk-1'))
    expect(created).toContainEqual({ title: 'Printer broken', description: 'Details here', priority: 'blocker', category: 'hardware' })
    expect(uploadAttachment).not.toHaveBeenCalled()
  })

  // Verifica «Cosa resta cablato», ondata 1: prima tre valori fissi con «medium» già scelto.
  it('offre le severità e le parole dell\'amministratore, senza nessuna preselezionata', async () => {
    const seen = { visibility: [], requirement: [] }
    renderWithProviders(<TicketNewPage />, { ...ROUTE, mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock] })
    const radios = await screen.findAllByRole('radio')
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual(['It stops my work', 'Medium', 'It can wait'])
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true)
  })

  it('severità non configurate → il messaggio del server, e nessun valore inventato', async () => {
    const seen = { visibility: [], requirement: [] }
    const notConfigured: GqlMock = {
      request: { query: GET_PORTAL_SEVERITY_CHOICES, variables: () => true },
      error: new Error('The severities offered in the portal are not configured'),
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    renderWithProviders(<TicketNewPage />, { ...ROUTE, mocks: [...rulesMocks(seen), kbMock, categoriesMock, notConfigured] })
    expect(await screen.findByText(/severities offered in the portal are not configured/)).toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  it('gli allegati passano da uploadAttachment("incident", id, file) dopo la creazione', async () => {
    const seen = { visibility: [], requirement: [] }
    const { user } = renderWithProviders(<TicketNewPage />, {
      ...ROUTE,
      mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock, createTicketMock({ title: 'Printer broken', description: 'Details here', priority: 'medium', category: 'hardware' })],
    })
    await fillForm(user)
    const file = new File(['hello'], 'screenshot.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)
    expect(screen.getByText('screenshot.png')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Submit ticket' }))
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1))
    expect(uploadAttachment).toHaveBeenCalledWith('incident', 'tk-1', file)
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tickets/tk-1'))
  })

  it('upload fallito → il ticket resta creato, banner con i file falliti, navigazione comunque', async () => {
    vi.mocked(uploadAttachment).mockRejectedValueOnce(new Error('413'))
    const seen = { visibility: [], requirement: [] }
    const { user } = renderWithProviders(<TicketNewPage />, {
      ...ROUTE,
      mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock, createTicketMock({ title: 'Printer broken', description: 'Details here', priority: 'medium', category: 'hardware' })],
    })
    await fillForm(user)
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'big.bin'))
    await user.click(screen.getByRole('button', { name: 'Submit ticket' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Ticket created, but some attachments failed to upload: big.bin')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tickets/tk-1'))
  })

  it('regole non caricate → nessuna mutation, banner esplicito (i campi obbligatori non diventano opzionali)', async () => {
    const seen = { visibility: [], requirement: [] }
    const created: unknown[] = []
    const { user } = renderWithProviders(<TicketNewPage />, {
      ...ROUTE,
      mocks: [categoriesMock, severityMock, ...rulesMocks(seen, { error: 'rules down' }), kbMock, createTicketMock({}, created)],
    })
    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Submit ticket' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to validate required fields: rules down')
    expect(created).toHaveLength(0)
    expect(screen.getByTestId('location')).toHaveTextContent('/tickets/new')
  })

  it('errore della mutation → banner con il messaggio del server, resta sulla pagina', async () => {
    const seen = { visibility: [], requirement: [] }
    const err: GqlMock = { request: { query: CREATE_TICKET, variables: () => true }, result: { errors: [{ message: 'Quota exceeded' }] } }
    const { user } = renderWithProviders(<TicketNewPage />, { ...ROUTE, mocks: [...rulesMocks(seen), kbMock, categoriesMock, severityMock, err] })
    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Submit ticket' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Quota exceeded')
    expect(screen.getByTestId('location')).toHaveTextContent('/tickets/new')
  })
})

/** Giro nel browser del 14 set 2026: le categorie erano cinque scritte nel codice, senza «security». */
describe('TicketNewPage — categorie dal Dizionario', () => {
  it('offre i valori del vocabolario del cliente, compreso security', async () => {
    renderWithProviders(<TicketNewPage />, { ...ROUTE, mocks: [...rulesMocks({ visibility: [], requirement: [] }), kbMock, categoriesMock, severityMock] })
    expect(await screen.findByRole('button', { name: 'Security' })).toBeInTheDocument()
  })
})

