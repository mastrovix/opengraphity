/**
 * CREATING A CHANGE: TWO STATES THE MAIN SUITES DO NOT REACH.
 *
 *  - The note under the type names the pre-approved types. They are
 *    configured in Domain matrices, their labels come from the `change_type`
 *    vocabulary: after a value is renamed or removed in the Dictionary, the
 *    configuration can still name a type the vocabulary no longer has. The
 *    note must then show it by its value — hiding it would tell the user that
 *    a type skips no approval when it does.
 *  - While the change is being created the button says so and cannot be
 *    pressed again: a second click would open a second, identical change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor, fireEvent } from '@testing-library/react'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

const busy = vi.hoisted(() => new Set<string>())

vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  return {
    ...fake,
    // A mutation can be made to be still running.
    useMutation: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useMutation>[1]) => {
      const [mutate, result] = fake.useMutation(doc, opts)
      return [mutate, { ...result, loading: busy.has(nomeOperazione(doc)) }]
    },
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { CreateChangePage } = await import('./CreateChangePage')

const DB = { id: 'ci-db', name: 'orders-db', type: 'database', environment: 'production', ownerGroup: { id: 't1' }, supportGroup: { id: 't2' } }

beforeEach(() => {
  apolloFinto.reset()
  busy.clear()
  apolloFinto.risposte['GetUserChoices'] = { users: [] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'change', ciTypes: [] }] }
  apolloFinto.risposte['GetTicketCreationCustomFields'] = { ticketCreationCustomFields: [] }
  apolloFinto.risposte['GetPreApprovedChangeTypes'] = { preApprovedChangeTypes: { types: ['standard', 'routine_patch'] } }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [DB] } }
})

const page = () => renderWithProviders(
  <DomainVocabularyContext.Provider value={{
    valuesOf: () => null, labelOf: () => null, colorOf: () => null, vocabularyLabelOf: () => null,
    entriesOf: (n) => (n === 'change_type' ? [{ value: 'standard', label: 'Standard', labels: [] }, { value: 'normal', label: 'Normal', labels: [] }] : null),
    loading: false, error: null,
  }}>
    <CreateChangePage />
  </DomainVocabularyContext.Provider>,
  { route: '/changes/new' },
)

describe('CreateChangePage — the pre-approved types in the note', () => {
  it('a pre-approved type the vocabulary no longer lists is named by its value, next to the labelled ones', () => {
    page()
    expect(screen.getByText(/^Standard, routine_patch: pre-approved, only the release plan is asked for their CIs/)).toBeInTheDocument()
  })
})

describe('CreateChangePage — while the change is being created', () => {
  it('the button says so and cannot be pressed again, even with everything filled in', async () => {
    busy.add('CreateChange')
    const { user } = page()
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Normal/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.type(screen.getByLabelText(/^Title/), 'Upgrade DB')
    await user.type(screen.getByLabelText(/^Why/), 'EOL')
    await user.type(screen.getByLabelText(/^What/), 'pg 16')
    fireEvent.change(screen.getByPlaceholderText('Search a CI by name...'), { target: { value: 'orders' } })
    await user.click(await screen.findByRole('button', { name: /orders-db/ }))
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Create the change' })).not.toBeInTheDocument()
  })
})
