/**
 * «Servizi che dipendono da questo CI» nel dettaglio CI: i servizi la cui
 * mappa include il CI (`servicesImpactedByCI`), con badge di salute,
 * punteggio d'impatto e link al dettaglio. Compare solo se c'è almeno un
 * servizio; un errore della query resta visibile (QueryError), non diventa
 * «nessun servizio».
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { QueryError } from '@/components/QueryError'
import { SectionCard } from '@/components/ui/SectionCard'
import { colors, palette } from '@/lib/tokens'
import { GET_SERVICES_IMPACTED_BY_CI } from '@/graphql/queries'
import { ServiceHealthBadge, ImpactScore, causeLabel } from '@/pages/monitoring/servicesShared'
import type { ServiceMapRow } from '@/types/services'

export function CIServicesSection({ ciId }: { ciId: string }) {
  const { t } = useTranslation()
  const { data, error, refetch } = useQuery<{ servicesImpactedByCI: ServiceMapRow[] }>(GET_SERVICES_IMPACTED_BY_CI, {
    variables: { ciId }, fetchPolicy: 'cache-and-network',
  })
  const items = data?.servicesImpactedByCI ?? []
  if (!error && items.length === 0) return null

  return (
    <SectionCard title={t('monitoring.services.ciSection.title')} count={data ? items.length : undefined} defaultOpen>
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {items.length > 0 && (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-table)', color: colors.slateLight }}>{t('monitoring.services.ciSection.hint')}</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((s) => {
              const first = s.explanation[0]
              return (
                <li key={s.id} data-testid="ci-service-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
                  <Link to={`/monitoring/services/${s.id}`} style={{ color: colors.brand, textDecoration: 'none', fontWeight: 600 }}>{s.name}</Link>
                  <ServiceHealthBadge health={s.health} />
                  <ImpactScore score={s.impactScore} health={s.health} width={60} />
                  {s.stale && (
                    <span role="img" aria-label={t('monitoring.services.staleShort')} title={t('monitoring.services.staleShort')} style={{ display: 'inline-flex', color: palette.warning.base }}>
                      <AlertTriangle size={13} aria-hidden="true" />
                    </span>
                  )}
                  {first && <span style={{ color: colors.slate, fontSize: 'var(--font-size-table)' }}>{causeLabel(t, first)}</span>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </SectionCard>
  )
}
