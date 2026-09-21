/**
 * LA PASTIGLIA della diagnostica in cima all'app (20 set 2026, decisione del
 * proprietario).
 *
 * L'elenco dei rilievi era un banner su ogni pagina e occupava un quinto dello
 * schermo. Quello che deve restare su ogni pagina non è l'elenco: è il FATTO
 * che ci sia qualcosa da sistemare, e quante. Un numero accanto alla campanella
 * lo dice in trenta pixel, e il resto si legge in Configurazione ▸ Diagnostica.
 *
 * Rosso se almeno un rilievo è un errore (qualcosa è ROTTO: un ticket non si
 * apre), ambra se sono solo avvisi. Quando non c'è niente non c'è la pastiglia:
 * un indicatore sempre acceso diventa invisibile in una settimana.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { useConfigurationIssues } from '@/hooks/useConfigurationIssues'
import { colors } from '@/lib/tokens'

export const PAGINA_DIAGNOSTICA = '/settings/diagnostics'

export function TopbarConfigurationIssues() {
  const { t } = useTranslation()
  const { issues, errors, mayRead } = useConfigurationIssues()

  if (!mayRead || issues.length === 0) return null

  const grave = errors > 0
  return (
    <Link
      to={PAGINA_DIAGNOSTICA}
      aria-label={t('configurationIssues.title', { count: issues.length })}
      title={t('configurationIssues.title', { count: issues.length })}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        height: 24, padding: '0 9px', borderRadius: 12,
        backgroundColor: grave ? 'var(--color-danger)' : 'var(--warning)',
        color: colors.white,
        fontSize: 11, fontWeight: 700, lineHeight: 1,
        textDecoration: 'none', flexShrink: 0,
      }}
    >
      <AlertTriangle size={12} aria-hidden="true" />
      {issues.length}
    </Link>
  )
}
