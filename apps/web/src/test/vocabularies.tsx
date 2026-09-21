/**
 * Il Dizionario del cliente nei test: `withVocabularyLabels(ui, { ci_status: { active: 'Active' } })`
 * monta `ui` con quelle etichette. Senza, `useDomainVocabularies().labelOf`
 * risponde `null` e le pagine mostrano il valore grezzo — come nel prodotto
 * prima che il Dizionario sia arrivato.
 */
import type { ReactElement } from 'react'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'

export type VocabularyLabels = Record<string, Record<string, string>>

/** Le etichette inglesi dei vocabolari dei CI come le spedisce il prodotto (quelle che i test usano). */
export const SHIPPED_CI_LABELS: VocabularyLabels = {
  ci_status:   { active: 'Active', inactive: 'Inactive', maintenance: 'Maintenance', decommissioned: 'Decommissioned' },
  environment: { production: 'Production', staging: 'Staging', development: 'Development', testing: 'Testing', dr: 'DR' },
}

export function withVocabularyLabels(ui: ReactElement, labels: VocabularyLabels = SHIPPED_CI_LABELS): ReactElement {
  const value: DomainVocabularies = {
    valuesOf:  (name) => (labels[name] ? Object.keys(labels[name]) : null),
    entriesOf: () => null,
    labelOf:   (name, v) => labels[name]?.[v] ?? null,
    colorOf:   () => null,
    vocabularyLabelOf: () => null,
    loading:   false,
    error:     null,
  }
  return <DomainVocabularyContext.Provider value={value}>{ui}</DomainVocabularyContext.Provider>
}
