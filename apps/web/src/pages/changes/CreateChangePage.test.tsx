/**
 * Verifica «Cosa resta cablato», ondata 1: i tipi di change erano tre bottoni
 * fissi (standard / normal / emergency) con `normal` già scelto, e la nota
 * diceva «Standard: nessuna approvazione» qualunque cosa avesse configurato il
 * cliente. Ora i tipi sono il vocabolario `change_type` DEL CLIENTE, nessuno è
 * preselezionato, e la nota nomina i tipi pre-approvati configurati.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { GET_USERS, GET_PRE_APPROVED_CHANGE_TYPES } from '@/graphql/queries'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { CreateChangePage } from './CreateChangePage'

const CHANGE_TYPES = [
  { value: 'standard', label: 'Standard', labels: [] },
  { value: 'normal', label: 'Normal', labels: [] },
  { value: 'major', label: 'Major', labels: [] },
]

const users: GqlMock = {
  request: { query: GET_USERS, variables: () => true },
  result: { data: { users: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
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
      entriesOf: (n) => (n === 'change_type' ? entries : null),
      loading: false, error: null,
    }}>{ui}</DomainVocabularyContext.Provider>
  )
}

describe('CreateChangePage — tipo di change', () => {
  it('offre i tipi del cliente (anche «Major»), senza nessuno preselezionato', async () => {
    const { user } = renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved(['standard'])] })
    const radios = await screen.findAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Standard', 'Normal', 'Major'])
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    await user.click(screen.getByRole('radio', { name: 'Major' }))
    expect(screen.getByRole('radio', { name: 'Major' })).toHaveAttribute('aria-checked', 'true')
  })

  it('la nota nomina i tipi pre-approvati configurati, con le etichette del cliente', async () => {
    renderWithProviders(withVocabulary(<CreateChangePage />), { route: '/changes/new', mocks: [users, preApproved(['standard', 'major'])] })
    await waitFor(() => expect(screen.getByText(/Standard, Major: pre-approved, no approval needed/)).toBeInTheDocument())
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
