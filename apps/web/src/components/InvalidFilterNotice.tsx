/**
 * «Il filtro di questo collegamento non si legge».
 *
 * Revisione totale · F-17: `useListQueryState` ignorava in silenzio un filtro
 * corrotto nell'URL (un link troncato dalla mail, scritto a mano) e mostrava
 * la lista SENZA filtri — chi apriva un collegamento «solo P1 aperti» vedeva
 * l'elenco completo e credeva che quelli fossero i P1. Questo avviso è lo
 * stesso accorgimento già usato dalla pagina degli allarmi, in un componente
 * perché lo usano sei liste.
 */
import { useTranslation } from 'react-i18next'

export function InvalidFilterNotice({ show }: { show: boolean }) {
  const { t } = useTranslation()
  if (!show) return null
  return (
    <p role="alert" style={{ margin: '0 0 16px', fontSize: 'var(--font-size-table)', color: 'var(--color-danger-text)' }}>
      {t('events.filters.advancedUrlInvalid')}
    </p>
  )
}
