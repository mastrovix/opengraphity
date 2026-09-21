/**
 * Giro UI del 15 set 2026 · U-9/U-11/U-26: i CI negli elenchi si leggono con le
 * etichette del tipo e del Dizionario, non coi valori interni.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import i18n from '@/i18n/i18n'
import { useCILabels } from './useCILabels'
import { MetamodelContext, type CITypeDef } from '@/contexts/MetamodelContext'

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

/**
 * IL NOME DI UN TIPO, NELLA LINGUA DI CHI GUARDA (20 set 2026, dal giro nel
 * browser: «Portale clienti — businessapplication»).
 *
 * La lingua era una tabella CABLATA di sei traduzioni usata da cinque pagine,
 * mentre altre tre mostravano l'etichetta del metamodello: lo stesso tipo si
 * leggeva «Application», «Applicazione» o col nome interno secondo la pagina.
 * Ora la lingua è dato — `labels` sul tipo — e la regola è una sola.
 */
function tipo(name: string, label: string, labels: { language: string; label: string }[] = []) {
  return { id: name, name, label, labels, icon: 'box', color: '#000', active: true, scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null, fields: [], relations: [], systemRelations: [] } as unknown as CITypeDef
}

const TIPI = [
  tipo('application', 'Application', [{ language: 'it', label: 'Applicazione' }]),
  tipo('server', 'Server'),
  tipo('business_application', 'Business Application', [{ language: 'it', label: 'Applicazione di business' }]),
]

function SondaTipi() {
  const { typeLabel } = useCILabels()
  return (
    <ul>
      <li>{typeLabel('application')}</li>
      <li>{typeLabel('server')}</li>
      <li>{typeLabel('tipo_cancellato')}</li>
      {/* L'etichetta Neo4j minuscola, come la scrivono le anomalie. */}
      <li>{typeLabel('businessapplication')}</li>
    </ul>
  )
}

describe('useCILabels — il nome di un tipo', () => {
  it('vince l\'etichetta nella lingua; senza traduzione vale quella di base; un tipo che non c\'è resta il nome', async () => {
    // I test girano in inglese (`src/test/setup.ts`): qui serve l'italiano,
    // perché è la lingua in cui il tipo ha una traduzione.
    await i18n.changeLanguage('it')
    const metamodello = {
      ciTypes: TIPI, loading: false, error: null,
      getCIType: (name: string) => TIPI.find((t) => t.name === name),
    }
    render(
      <MetamodelContext.Provider value={metamodello}>
        {wrap(<SondaTipi />)}
      </MetamodelContext.Provider>,
    )
    expect(screen.getAllByRole('listitem').map((li) => li.textContent))
      .toEqual(['Applicazione', 'Server', 'tipo_cancellato', 'Applicazione di business'])
    // In inglese vale l'etichetta di base: il tipo non ha una voce `en`.
    await i18n.changeLanguage('en')
  })
})

