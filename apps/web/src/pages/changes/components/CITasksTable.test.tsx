/** Secondo giro UI del 15 set 2026 · V-2: la tabella «Task attivi» mostrava «business_application · production». */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { CITasksTable } from './CITasksTable'
import type { AffectedCI } from '@/types/change'

const vocab = {
  valuesOf: () => null, entriesOf: () => null, colorOf: () => null, vocabularyLabelOf: () => null, loading: false, error: null,
  labelOf: (n: string, v: string) => (n === 'environment' && v === 'production' ? 'Produzione' : null),
} as DomainVocabularies

const affected = [{
  ciPhase: 'assessment', riskScore: null,
  ci: { id: 'ba-1', name: 'Portale clienti', type: 'business_application', environment: 'production', ownerGroup: null, supportGroup: null },
  assessmentOwner: null, assessmentSupport: null, deployPlan: null, validation: null, deployment: null, review: null,
}] as AffectedCI[]

describe('CITasksTable', () => {
  it('ambiente con l\'etichetta del Dizionario, mai il valore interno', async () => {
    renderWithProviders(
      <DomainVocabularyContext.Provider value={vocab}>
        <CITasksTable affected={affected} actsForAnyTeam userTeamIds={new Set()} />
      </DomainVocabularyContext.Provider>,
    )
    expect(await screen.findByText('Produzione')).toBeInTheDocument()
    expect(screen.queryByText('production')).toBeNull()
  })
})
