/**
 * Banner in testa alla console allarmi: almeno un servizio critico
 * è giù adesso. QUALI criticità rendono «critico» un servizio lo dice il
 * server (`criticalServiceCriticalities`, ondata 7): sono le celle della
 * matrice `service_impact` del cliente che portano all'impatto più alto.
 *
 * Stessa forma del banner di tempesta (StormBanner): ambra, `role="status"`
 * (è un avviso, non un errore), una riga per servizio con `<Trans>` — così
 * l'ordine delle parole e il link restano alla lingua — e il rimando alla
 * pagina Servizi filtrata sugli stessi servizi che il banner conta.
 *
 * Guarda solo le mappe `active`: una mappa in pausa non viene valutata e una
 * bozza non è ancora in servizio, la loro salute è vecchia.
 * Nessuna riga (nessun servizio critico giù, o query ancora in volo) → niente
 * banner. Un errore della query non diventa «va tutto bene»: è una riga
 * visibile con il messaggio del server (chiave propria, non quella del widget).
 *
 * Revisione 2 (C-7): la criticità è un filtro del SERVER
 * (`ServiceMapFilter.criticality`). Prima si leggevano i primi 20 servizi giù
 * e si scartava la criticità a valle: in una tempesta con venti servizi non
 * critici giù, i critici non entravano nella pagina letta e il banner taceva.
 * Il conteggio del titolo è il `total` del server, non la lunghezza
 * dell'elenco: oltre il limite il banner elenca i primi e il titolo dice
 * comunque quanti sono.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { Trans, useTranslation } from 'react-i18next'
import { XCircle } from 'lucide-react'
import { GET_SERVICE_MAPS, GET_CRITICAL_SERVICE_CRITICALITIES } from '@/graphql/queries'
import { enumLabel } from '@/lib/ciEnums'
import { pausedWhenHidden } from '@/lib/polling'
import { AMBER_BANNER } from '@/lib/eventPalette'
import { colors } from '@/lib/tokens'
import { servicePath } from './ServicesPage'
import type { ServiceMapFilterVars, ServiceMapPage, ServiceMapRow } from '@/types/services'

/** Filtro del banner: solo mappe attive, giù e critiche — tutto e tre lato server. */
const filterFor = (criticality: readonly string[]): ServiceMapFilterVars => ({
  health: ['down'], status: 'active', criticality: [...criticality],
})
/** Il link va alla lista dei servizi giù (l'etichetta dice «Servizi giù», non «critici»): un soprainsieme onesto. */
export const CRITICAL_SERVICES_PATH = '/monitoring/services?health=down&status=active'

const POLL_MS = 30_000
/** Quanti servizi critici giù elencare: il titolo conta comunque il totale del server. */
const LIMIT = 20

const linkStyle = { color: AMBER_BANNER.text, fontWeight: 600 } as const

export function CriticalServicesBanner() {
  const { t } = useTranslation()
  // Ondata 7 (C-7): quali criticità contano lo dice il SERVER, leggendo la
  // matrice `service_impact` del cliente (le celle che portano all'impatto
  // più alto). Prima erano due valori scritti qui e mandati al server come
  // filtro: un servizio con una criticità aggiunta dall'admin non compariva
  // mai nel banner, in silenzio.
  const { data: critData, error: critError } =
    useQuery<{ criticalServiceCriticalities: string[] }>(GET_CRITICAL_SERVICE_CRITICALITIES, { fetchPolicy: 'cache-first' })
  const criticalities = critData?.criticalServiceCriticalities

  const { data, error } = useQuery<{ serviceMaps: ServiceMapPage }>(GET_SERVICE_MAPS, {
    variables: { filter: filterFor(criticalities ?? []), limit: LIMIT, offset: 0 },
    // Finché non si sa quali criticità contano non si chiede niente: un filtro
    // vuoto vorrebbe dire «tutte», e il banner conterebbe servizi non critici.
    skip: !criticalities?.length,
    fetchPolicy: 'cache-and-network',
    ...pausedWhenHidden(POLL_MS),
  })

  if (critError) {
    return (
      <p role="alert" style={{ margin: '0 0 16px', fontSize: 'var(--font-size-table)', color: colors.danger }}>
        {t('monitoring.criticalBanner.loadError', { error: critError.message })}
      </p>
    )
  }

  if (error && !data) {
    return (
      <p role="alert" style={{ margin: '0 0 16px', fontSize: 'var(--font-size-table)', color: colors.danger }}>
        {t('monitoring.criticalBanner.loadError', { error: error.message })}
      </p>
    )
  }

  // Il server ha già filtrato la criticità: qui non si rifiltra. Una riga senza
  // criticità non può aver superato quel filtro: se arriva è una rottura del
  // contratto e si dice in console, non si mostra una riga «è giù ()».
  const critical = (data?.serviceMaps.items ?? []).flatMap((s: ServiceMapRow) => {
    if (s.service.criticality === null) {
      console.error(`CriticalServicesBanner: serviceMaps(criticality: ${(criticalities ?? []).join(', ')}) ha restituito «${s.name}» senza criticità`)
      return []
    }
    return [{ id: s.id, name: s.name, criticality: s.service.criticality }]
  })
  if (critical.length === 0) return null
  // Sopra il limite l'elenco è parziale ma il conteggio no: «22 servizi critici sono giù» con 20 righe.
  const total = data?.serviceMaps.total ?? critical.length

  return (
    <div role="status" data-testid="critical-services-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', marginBottom: 16, background: AMBER_BANNER.bg, border: `1px solid ${AMBER_BANNER.border}`, borderRadius: 8, color: AMBER_BANNER.text, fontSize: 'var(--font-size-body)' }}>
      <XCircle size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('monitoring.services.criticalBanner.title', { count: total })}</div>
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
