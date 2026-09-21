/**
 * Sotto la ricerca dei CI da collegare a un ticket nuovo: quali tipi di CI non
 * si propongono, e perché. Giro UI del 15 set 2026 · U-10: la ricerca ometteva
 * i tipi esclusi (CM-8) senza dirlo, e chi cercava un'applicazione pensava che
 * non esistesse. I tipi si leggono con la loro etichetta.
 */
import { useTranslation } from 'react-i18next'
import { useCILabels } from '@/hooks/useCILabels'

export function CIExclusionHint({ excluded, id }: { excluded: readonly string[] | undefined; id?: string }) {
  const { t } = useTranslation()
  const { typeLabel } = useCILabels()
  if (!excluded || excluded.length === 0) return null
  return (
    <p id={id} data-testid="ci-exclusion-hint" style={{ margin: '0 0 6px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
      {t('pages.createTicket.ciTypesExcluded', { count: excluded.length, types: excluded.map(typeLabel).join(', ') })}
    </p>
  )
}
