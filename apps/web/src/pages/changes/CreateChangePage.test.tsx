/**
 * Verifica «Cosa resta cablato», ondata 1: i tipi di change erano tre bottoni
 * fissi (standard / normal / emergency) con `normal` già scelto, e la nota
 * diceva «Standard: nessuna approvazione» qualunque cosa avesse configurato il
 * cliente. Ora i tipi sono il vocabolario `change_type` DEL CLIENTE, nessuno è
 * preselezionato, e la nota nomina i tipi pre-approvati configurati.
 */
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GET_PRE_APPROVED_CHANGE_TYPES, GET_ALL_CIS, GET_CI_GROUPS_BY_ID, GET_TICKET_CI_EXCLUSIONS } from '@/graphql/queries'
import { userSearchMock } from '@/test/mocks/gql'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { CreateChangePage } from './CreateChangePage'

const CHANGE_TYPES = [
  { value: 'standard', label: 'Standard', labels: [] },
  { value: 'normal', label: 'Normal', labels: [] },
  { value: 'major', label: 'Major', labels: [] },
]

/** The owner picker's people (D21): none needed by these tests. */
const users: GqlMock = userSearchMock([])
const preApproved = (types: string[]): GqlMock => ({
  request: { query: GET_PRE_APPROVED_CHANGE_TYPES },
  result: { data: { preApprovedChangeTypes: { __typename: 'PreApprovedChangeTypes', types, vocabulary: CHANGE_TYPES.map((t) => t.value) } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function withVocabulary(ui: React.ReactElement, entries: typeof CHANGE_TYPES | null = CHANGE_TYPES) {
  return (
    <DomainVocabularyContext.Provider value={{
      valuesOf:  (n) => (n === 'change_type' && entries ? entries.map((e) => e.value) : null),
      labelOf:   () => null,
      colorOf:   () => null,
      vocabularyLabelOf: () => null, entriesOf: (n) => (n === 'change_type' ? entries : null),
      loading: false, error: null,
    }}>{ui}</DomainVocabularyContext.Provider>
  )
}

/**
 * IL TIPO SI SCEGLIE PRIMA, IN UN MODALE (20 set 2026, richiesta del
 * proprietario: «quando clicco su nuova change deve prima apparirmi un
 * modale con i tipi di change, non voglio selezionare il tipo direttamente
 * dalla form»). Prima erano tre bottoni radio in mezzo agli altri campi.
 *
 * Quello che questi test tengono fermo, oltre alla forma: i tipi restano
 * quelli del VOCABOLARIO DEL CLIENTE — «Major» non è uno dei tre spediti — e
 * nessuno è preselezionato.
 */
describe('CreateChangePage — tipo di change', () => {
  it('il modale si apre da solo e offre i tipi del cliente, «Major» compreso', async () => {
    const { user } = renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved(['standard'])] })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('What kind of change is this?')).toBeInTheDocument()
    for (const etichetta of ['Standard', 'Normal', 'Major']) {
      expect(within(dialog).getByRole('button', { name: new RegExp(etichetta) })).toBeInTheDocument()
    }

    // Scelto il tipo, il modale si chiude e la form lo MOSTRA: non è una
    // scelta che sparisce, si rilegge e si può cambiare.
    await user.click(within(dialog).getByRole('button', { name: /Major/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Major')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument()
  })

  it('«Cambia» riapre il modale: un tipo scelto per sbaglio non blocca nessuno', async () => {
    const { user } = renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved(['standard'])] })
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /Normal/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Change' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('il tipo PRE-APPROVATO si vede mentre si sceglie, non dopo', async () => {
    renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved(['standard'])] })
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Standard/ })).toHaveTextContent('Pre-approved'))
    expect(within(dialog).getByRole('button', { name: /Normal/ })).not.toHaveTextContent('Pre-approved')
  })

  it('la nota nomina i tipi pre-approvati configurati, con le etichette del cliente', async () => {
    renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved(['standard', 'major'])] })
    await waitFor(() => expect(screen.getByText(/Standard, Major: pre-approved, only the release plan is asked for their CIs — no assessment, no approval/)).toBeInTheDocument())
  })

  it('nessun tipo pre-approvato → tutti passano dall\'approvazione, e lo dice', async () => {
    renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved([])] })
    await waitFor(() => expect(screen.getByText(/Every type goes through approval/)).toBeInTheDocument())
  })

  it('vocabolario vuoto → lo dice e indica dove si aggiungono i valori', async () => {
    renderWithProviders(withVocabulary(<CreateChangePage />, []), { route: '/changes/new', mocks: [users, preApproved([])] })
    expect(await screen.findByText(/No change type is defined/)).toBeInTheDocument()
  })
})

// ── Secondo giro UI del 15 set 2026 · V-1 ────────────────────────────────────

describe('CreateChangePage — CI senza gruppi (V-1)', () => {
  it('«Ricontrolla» rilegge i gruppi del CI: il chip torna normale senza toglierlo e riaggiungerlo', async () => {
    const ci = { __typename: 'CI', id: 'ba-1', name: 'Portale clienti', type: 'business_application', status: 'active', environment: 'production', description: null, createdAt: 'T', health: null }
    const mocks: GqlMock[] = [
      users, preApproved(['standard']),
      { request: { query: GET_TICKET_CI_EXCLUSIONS, variables: { ticketType: 'change' } }, result: { data: { ticketCIExclusions: [{ __typename: 'TicketCIExclusion', ticketType: 'change', ciTypes: [] }] } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: GET_ALL_CIS, variables: () => true }, result: { data: { allCIs: { __typename: 'AllCIsResult', total: 1, items: [{ ...ci, ownerGroup: null, supportGroup: null }] } } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: GET_CI_GROUPS_BY_ID, variables: { id: 'ba-1' } }, result: { data: { ciById: { __typename: 'BusinessApplication', id: 'ba-1', ownerGroup: { __typename: 'Team', id: 't1', name: 'Sistemi' }, supportGroup: { __typename: 'Team', id: 't2', name: 'Service Desk' } } } } },
    ]
    const { user } = renderWithProviders(withVocabulary(<CreateChangePage />), { mocks, route: '/changes/new', path: '/changes/new' })
    const search = await screen.findByPlaceholderText('Search a CI by name...')
    fireEvent.change(search, { target: { value: 'Portale' } })
    await user.click(await screen.findByRole('button', { name: /Portale clienti/ }))
    const alert = await screen.findByText(/These CIs have no Owner Group or Support Group/)
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(alert).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Remove Portale clienti' })).toBeInTheDocument()
  })
  it('tornando sulla scheda (visibilitychange) i gruppi si rileggono da soli', async () => {
    const ci = { __typename: 'CI', id: 'ba-1', name: 'Portale clienti', type: 'business_application', status: 'active', environment: 'production', description: null, createdAt: 'T', health: null }
    const mocks: GqlMock[] = [
      users, preApproved(['standard']),
      { request: { query: GET_TICKET_CI_EXCLUSIONS, variables: { ticketType: 'change' } }, result: { data: { ticketCIExclusions: [{ __typename: 'TicketCIExclusion', ticketType: 'change', ciTypes: [] }] } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: GET_ALL_CIS, variables: () => true }, result: { data: { allCIs: { __typename: 'AllCIsResult', total: 1, items: [{ ...ci, ownerGroup: null, supportGroup: null }] } } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: GET_CI_GROUPS_BY_ID, variables: { id: 'ba-1' } }, result: { data: { ciById: { __typename: 'BusinessApplication', id: 'ba-1', ownerGroup: { __typename: 'Team', id: 't1', name: 'Sistemi' }, supportGroup: { __typename: 'Team', id: 't2', name: 'Service Desk' } } } } },
    ]
    const { user } = renderWithProviders(withVocabulary(<CreateChangePage />), { mocks, route: '/changes/new', path: '/changes/new' })
    const search = await screen.findByPlaceholderText('Search a CI by name...')
    fireEvent.change(search, { target: { value: 'Portale' } })
    await user.click(await screen.findByRole('button', { name: /Portale clienti/ }))
    const alert = await screen.findByText(/These CIs have no Owner Group or Support Group/)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(alert).not.toBeInTheDocument())
  })
})
