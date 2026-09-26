/**
 * «Capacità di business» in fondo alla pagina Servizi (ondata 3): elenco in
 * SOLA LETTURA delle capacità con la salute peggiore fra i servizi che le
 * abilitano, quanti di quei servizi sono giù o degradati e i servizi stessi
 * come link. Nessun controllo di modifica: le capacità si configurano nella
 * CMDB, qui si guarda soltanto.
 *
 * Una capacità senza alcun servizio con salute nota arriva `unknown` dal
 * server: il badge lo dice, non si inventa «operativa». Un errore della query
 * resta visibile (QueryError con Riprova), non diventa «nessuna capacità».
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { QueryError } from '@/components/QueryError'
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import { SimpleTable, type SimpleColumn } from '@/components/ui/SimpleTable'
import { GET_BUSINESS_CAPABILITIES_HEALTH } from '@/graphql/queries'
import { colors } from '@/lib/tokens'
import { TINT_CRITICAL, TINT_WARNING } from '@/lib/eventPalette'
import { ServiceHealthBadge } from './servicesShared'
import type { BusinessCapabilityHealth } from '@/types/services'

/**
 * `services` sono le applicazioni di business che abilitano la capacità
 * (`ServiceRef`), non le mappe: il loro id non apre `/monitoring/services/:id`,
 * che vuole l'id della ServiceMap. Il link porta quindi alla lista filtrata
 * per nome, che funziona anche per un'applicazione ancora senza mappa.
 */
const serviceSearchPath = (name: string) => `/monitoring/services?q=${encodeURIComponent(name)}`

const badgeFont = { fontSize: 'var(--font-size-label)' } as const

export function BusinessCapabilitiesSection() {
  const { t } = useTranslation()
  const { data, error, refetch } = useQuery<{ businessCapabilitiesHealth: BusinessCapabilityHealth[] }>(GET_BUSINESS_CAPABILITIES_HEALTH, {
    fetchPolicy: 'cache-and-network',
  })
  const items = data?.businessCapabilitiesHealth ?? []
  // The app's small table (26 Sep 2026). Read only: a row opens nothing, the services are links.
  const columns: SimpleColumn<BusinessCapabilityHealth>[] = [
    { key: 'name', label: t('monitoring.services.capabilities.title'), render: (_v, cap) => <span style={{ fontWeight: 600 }}>{cap.name}</span> },
    { key: 'health', label: t('monitoring.services.columns.health'), width: '150px', render: (_v, cap) => <ServiceHealthBadge health={cap.health} /> },
    { key: 'downServices', label: t('monitoring.services.columns.impact'), width: '180px', render: (_v, cap) => (
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
        {cap.downServices > 0 && (
          <Pill bg={TINT_CRITICAL.bg} color={TINT_CRITICAL.color} style={badgeFont}>{t('monitoring.services.capabilities.down', { count: cap.downServices })}</Pill>
        )}
        {cap.degradedServices > 0 && (
          <Pill bg={TINT_WARNING.bg} color={TINT_WARNING.color} style={badgeFont}>{t('monitoring.services.capabilities.degraded', { count: cap.degradedServices })}</Pill>
        )}
        {cap.downServices === 0 && cap.degradedServices === 0 && <span style={{ color: colors.slateLight }}>—</span>}
      </span>
    ) },
    { key: 'services', label: t('monitoring.services.capabilities.services'), render: (_v, cap) => cap.services.length === 0
      ? <span style={{ color: colors.slateLight }}>{t('monitoring.services.capabilities.noServices')}</span>
      : (
        <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
          {cap.services.map((s) => (
            <Link key={s.id} to={serviceSearchPath(s.name)} style={{ color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, fontWeight: 500 }}>{s.name}</Link>
          ))}
        </span>
      ) },
  ]

  // Aperta di default: `defaultOpen` è letto al primo render, quando i dati non sono ancora arrivati.
  return (
    <SectionCard title={t('monitoring.services.capabilities.title')} count={data ? items.length : undefined} collapsible defaultOpen>
      <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-table)', color: colors.slateLight }}>{t('monitoring.services.capabilities.hint')}</p>
      {error && !data && <QueryError message={t('monitoring.services.capabilities.error', { error: error.message })} onRetry={() => void refetch()} />}
      {data && items.length === 0 && (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('monitoring.services.capabilities.empty')}</p>
      )}
      {items.length > 0 && <SimpleTable<BusinessCapabilityHealth> label={t('monitoring.services.capabilities.title')} columns={columns} rows={items} />}
    </SectionCard>
  )
}
