/**
 * Corpo del widget «Salute dei servizi» (Servizi monitorati, ondata 3): i
 * contatori del tenant (`serviceMaps.counts`) — giù, degradati, in
 * manutenzione, operativi — ognuno un link alla pagina Servizi già filtrata
 * (`/monitoring/services?health=…`). Registrato nel sistema dei widget come
 * tipo `service_health` (WIDGET_TYPES in useWidgetConfig): entità e metrica
 * non si configurano, la sorgente dei dati è sempre la pagina Servizi.
 *
 * Come «Allarmi attivi»: la pagina Servizi è riservata allo staff (rotte
 * `staff(...)` in main.tsx, stesso predicato `isStaff`), quindi a un end user
 * il widget lo dice invece di linkare una pagina «accesso negato»; polling in
 * pausa a scheda nascosta; un errore resta visibile, mai contatori finti.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Boxes } from 'lucide-react'
import { GET_SERVICE_HEALTH_COUNTS } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import { isStaff } from '@/lib/roles'
import { colors } from '@/lib/tokens'
import { pausedWhenHidden } from '@/lib/polling'
import { SERVICE_HEALTH_ACCENT } from '@/pages/monitoring/servicesShared'
import type { ServiceHealth, ServiceMapCounts } from '@/types/services'

export const SERVICE_HEALTH_WIDGET_TYPE = 'service_health'
/** Polling in pausa a scheda nascosta (lib/polling). */
const POLL_MS = 30_000

/** I quattro contatori cliccabili; «sconosciuti» resta fuori: nella pagina Servizi non è un filtro. */
const TILES: readonly ServiceHealth[] = ['down', 'degraded', 'maintenance', 'operational']

export function ServiceHealthWidget({ color, large = false }: { color: string; large?: boolean }) {
  const { t } = useTranslation()
  const { role, loading: meLoading } = useMe()
  const staff = isStaff(role)
  const { data, loading, error } = useQuery<{ serviceMaps: { counts: ServiceMapCounts } }>(GET_SERVICE_HEALTH_COUNTS, {
    ...pausedWhenHidden(POLL_MS), fetchPolicy: 'cache-and-network', skip: !staff,
  })
  const counts = data?.serviceMaps.counts

  if (!staff) {
    // Finché `me` non risponde non si sa il ruolo: nessun messaggio prematuro.
    if (meLoading || role === null) return null
    return <p style={{ padding: 16, margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate }}>{t('pages.dashboard.serviceHealthStaffOnly')}</p>
  }

  if (error && !counts) {
    return <div role="alert" style={{ padding: 16, fontSize: 'var(--font-size-body)', color: colors.danger }}>{t('monitoring.widget.loadError', { error: error.message })}</div>
  }

  return (
    <div style={{ padding: large ? '20px 20px 16px' : '14px 14px 12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        {TILES.map((health) => (
          <Link
            key={health}
            to={`/monitoring/services?health=${health}`}
            aria-label={`${t(`monitoring.services.tiles.${health}`)} ${counts ? counts[health] : '—'}`}
            style={{ textDecoration: 'none', textAlign: 'center', padding: '10px 6px', borderRadius: 8, background: 'var(--color-slate-bg)', border: `1px solid ${colors.border}` }}
          >
            <div style={{ fontSize: large ? 32 : 26, fontWeight: 700, color: SERVICE_HEALTH_ACCENT[health], lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
              {counts ? counts[health] : loading ? '…' : '—'}
            </div>
            <div style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 }}>
              {t(`monitoring.services.tiles.${health}`)}
            </div>
          </Link>
        ))}
      </div>
      <Link to="/monitoring/services" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 'var(--font-size-table)', color, textDecoration: 'none', fontWeight: 600 }}>
        <Boxes size={12} aria-hidden="true" />{t('monitoring.widget.openServices')}
      </Link>
    </div>
  )
}
