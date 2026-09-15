/**
 * Il corpo della conferma «Eliminare il tipo?» (regola del proprietario, 15
 * set 2026): cosa va via insieme al tipo, coi numeri, PRIMA di confermare.
 *
 * Prima il disegnatore chiedeva solo «Eliminare il tipo X?» e l'API rifiutava
 * appena c'era un riferimento qualunque — anche i collegamenti alle domande
 * core dell'assessment che la creazione mette da sé. Ora il solo impedimento è
 * un ticket che cita un CI del tipo (`ticketCIs > 0`), e il resto si cancella:
 * per questo va detto qui, voce per voce.
 */
import type { TFunction } from 'i18next'

export interface CITypeDeletionImpactData {
  cis:                     number
  ticketCIs:               number
  tickets:                 number
  ticketCIExclusions:      number
  groupsUpdated:           number
  groupsDeleted:           number
  fieldVisibilityRules:    number
  fieldRequirementRules:   number
  businessRules:           number
  autoTriggers:            number
  customWidgets:           number
  reportSections:          number
  assessmentQuestionLinks: number
}

/** Le voci nell'ordine in cui si leggono: prima i dati, poi la configurazione. */
export const DELETION_IMPACT_ITEMS = [
  'cis', 'groupsDeleted', 'groupsUpdated', 'ticketCIExclusions', 'fieldVisibilityRules', 'fieldRequirementRules',
  'businessRules', 'autoTriggers', 'customWidgets', 'reportSections', 'assessmentQuestionLinks',
] as const satisfies readonly (keyof CITypeDeletionImpactData)[]

export function CITypeDeletionImpact({ impact, t }: { impact: CITypeDeletionImpactData; t: TFunction }) {
  const items = DELETION_IMPACT_ITEMS.filter((k) => impact[k] > 0)
  if (items.length === 0) return <p style={{ margin: 0 }}>{t('ciTypeDesigner.deleteImpact.nothing')}</p>
  return (
    <div data-testid="ci-type-deletion-impact">
      <p style={{ margin: '0 0 6px' }}>{t('ciTypeDesigner.deleteImpact.intro')}</p>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((k) => <li key={k}>{t(`ciTypeDesigner.deleteImpact.${k}`, { count: impact[k] })}</li>)}
      </ul>
    </div>
  )
}
