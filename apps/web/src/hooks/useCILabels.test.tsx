/**
 * Giro UI del 15 set 2026 · U-9/U-11/U-26: i CI negli elenchi si leggono con le
 * etichette del tipo e del Dizionario, non coi valori interni.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useCILabels } from './useCILabels'

const LABELS: Record<string, Record<string, string>> = {
  environment: { production: 'Produzione', dr: 'Disaster recovery' },
  ci_status:   { maintenance: 'In manutenzione' },
}
const vocabularies = {
  valuesOf: () => null, entriesOf: () => null, colorOf: () => null, loading: false, error: null,
  labelOf: (name: string, value: string) => LABELS[name]?.[value] ?? null,
} as unknown as DomainVocabularies

function Probe() {
  const l = useCILabels()
  return (
    <ul>
      <li>{l.subtitle({ type: 'application', environment: 'production' })}</li>
      <li>{l.subtitle({ type: 'server', environment: null })}</li>
      <li>{l.environmentLabel('dr')}</li>
      <li>{l.statusLabel('maintenance')}</li>
      <li>{l.environmentLabel('lab')}</li>
    </ul>
  )
}

const wrap = (ui: ReactNode) => <DomainVocabularyContext.Provider value={vocabularies}>{ui}</DomainVocabularyContext.Provider>

describe('useCILabels', () => {
  it('etichette del Dizionario; un valore che il vocabolario non ha resta com\'è', () => {
    render(wrap(<Probe />))
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    // Senza MetamodelProvider il tipo non ha etichetta: resta il nome interno.
    expect(items).toEqual(['application · Produzione', 'server', 'Disaster recovery', 'In manutenzione', 'lab'])
  })
})
