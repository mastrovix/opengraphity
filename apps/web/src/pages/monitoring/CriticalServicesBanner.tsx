/**
 * Banner in testa alla console allarmi: almeno un servizio critico
 * (`mission_critical` / `business_critical`) è giù adesso.
 *
 * Stessa forma del banner di tempesta (StormBanner): ambra, `role="status"`
 * (è un avviso, non un errore), una riga per servizio con `<Trans>` — così
 * l'ordine delle parole e il link restano alla lingua — e il rimando alla
 * pagina Servizi filtrata sugli stessi servizi che il banner conta.
 *
 * Guarda solo le mappe `active`: una mappa in pausa non viene valutata e una
 * bozza non è ancora in servizio, la loro salute è vecchia. Il link porta a
 * `?health=down&status=active`: esattamente ciò che è stato contato.
 * Nessuna riga (nessun servizio critico giù, o query ancora in volo) → niente
 * banner. Un errore della query non diventa «va tutto bene»: è una riga
 * visibile con il messaggio del server.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { Trans, useTranslation } from 'react-i18next'
import { XCircle } from 'lucide-react'
import { GET_SERVICE_MAPS } from '@/graphql/queries'
import { enumLabel } from '@/lib/ciEnums'
import { pausedWhenHidden } from '@/lib/polling'
import { AMBER_BANNER } from '@/lib/eventPalette'
import { colors } from '@/lib/tokens'
import { servicePath } from './ServicesPage'
import type { ServiceMapPage, ServiceMapRow } from '@/types/services'

/** Criticità che rendono «critico» un servizio (enum `criticality` del metamodello). */
export const CRITICAL_CRITICALITIES: readonly string[] = ['mission_critical', 'business_critical']

/** Filtro e link del banner: solo mappe attive e giù. */
const FILTER = { health: ['down'], status: 'active' } as const
export const CRITICAL_SERVICES_PATH = '/monitoring/services?health=down&status=active'

const POLL_MS = 30_000
/** Quanti servizi giù leggere: il banner ne elenca al massimo questi. */
const LIMIT = 20

const linkStyle = { color: AMBER_BANNER.text, fontWeight: 600 } as const

export function CriticalServicesBanner() {
  const { t } = useTranslation()
  const { data, error } = useQuery<{ serviceMaps: ServiceMapPage }>(GET_SERVICE_MAPS, {
    variables: { filter: FILTER, limit: LIMIT, offset: 0 },
    fetchPolicy: 'cache-and-network',
    ...pausedWhenHidden(POLL_MS),
  })

  if (error && !data) {
    return (
      <p role="alert" style={{ margin: '0 0 16px', fontSize: 'var(--font-size-table)', color: colors.danger }}>
        {t('monitoring.widget.loadError', { error: error.message })}
      </p>
    )
  }

  // La criticità è portata avanti con la riga: dentro la lista non è più nulla e non serve un ripiego.
  const critical = (data?.serviceMaps.items ?? []).flatMap((s: ServiceMapRow) =>
    s.service.criticality !== null && CRITICAL_CRITICALITIES.includes(s.service.criticality)
      ? [{ id: s.id, name: s.name, criticality: s.service.criticality }]
      : [])
  if (critical.length === 0) return null

  return (
    <div role="status" data-testid="critical-services-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', marginBottom: 16, background: AMBER_BANNER.bg, border: `1px solid ${AMBER_BANNER.border}`, borderRadius: 8, color: AMBER_BANNER.text, fontSize: 'var(--font-size-body)' }}>
      <XCircle size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('monitoring.services.criticalBanner.title', { count: critical.length })}</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.5 }}>
          {critical.map((s) => (
            <li key={s.id}>
              <Trans
                i18nKey="monitoring.services.criticalBanner.line"
                values={{ name: s.name, criticality: enumLabel(s.criticality) }}
                components={{ service: <Link to={servicePath(s.id)} style={linkStyle} /> }}
              />
            </li>
          ))}
        </ul>
      </div>
      <Link to={CRITICAL_SERVICES_PATH} style={{ ...linkStyle, whiteSpace: 'nowrap' }}>{t('monitoring.services.criticalBanner.viewAll')} →</Link>
    </div>
  )
}
