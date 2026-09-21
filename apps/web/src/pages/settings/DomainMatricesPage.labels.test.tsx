/**
 * Giro UI del 15 set 2026 · U-20: le matrici di dominio intestavano righe e
 * colonne coi nomi interni («impact», «high») e le tendine offrivano i valori
 * interni. Si leggono con le etichette del Dizionario del cliente.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { GET_DOMAIN_MATRICES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { DomainMatricesPage } from './DomainMatricesPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }))

const VOCABS: Record<string, string> = { impact: 'Impatto', urgency: 'Urgenza', priority: 'Priorità' }
const VALUES: Record<string, Record<string, string>> = {
  impact: { high: 'Alto', low: 'Basso' }, urgency: { high: 'Alta', low: 'Bassa' }, priority: { p1: 'Critica', p2: 'Normale' },
}
const vocab = {
  valuesOf: () => null, entriesOf: () => null, colorOf: () => null, loading: false, error: null,
  labelOf: (n: string, v: string) => VALUES[n]?.[v] ?? null,
  vocabularyLabelOf: (n: string) => VOCABS[n] ?? null,
} as DomainVocabularies

const matrices: GqlMock = {
  request: { query: GET_DOMAIN_MATRICES },
  result: { data: { domainMatrices: [{
    __typename: 'DomainMatrix', kind: 'priority', inputs: ['impact', 'urgency'], output: 'priority',
    inputValues: [['high', 'low'], ['high', 'low']], outputValues: ['p1', 'p2'],
    cells: [['high', 'high', 'p1'], ['high', 'low', 'p2'], ['low', 'high', 'p2'], ['low', 'low', 'p2']]
      .map(([i, u, v]) => ({ __typename: 'DomainMatrixCell', key: `${i}|${u}`, inputs: [i, u], value: v })),
    missing: [], stale: [], invalid: [], isDefault: false, updatedAt: null,
  }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('DomainMatricesPage — etichette del Dizionario (U-20)', () => {
  it('intestazioni, righe e tendine con le etichette; i nomi delle celle le usano', async () => {
    renderWithProviders(
      <DomainVocabularyContext.Provider value={vocab}><DomainMatricesPage /></DomainVocabularyContext.Provider>,
      { route: '/settings/domain-matrices', mocks: [matrices], showWarnings: false },
    )
    const cell = await screen.findByRole('combobox', { name: 'Impatto Alto, Urgenza Bassa' })
    const table = cell.closest('table')!
    expect(within(table).getByRole('columnheader', { name: 'Impatto' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Alta' })).toBeInTheDocument()
    expect(within(table).getByRole('rowheader', { name: 'Basso' })).toBeInTheDocument()
    expect(within(cell).getByRole('option', { name: 'Normale' })).toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'impact' })).toBeNull()
  })
})
