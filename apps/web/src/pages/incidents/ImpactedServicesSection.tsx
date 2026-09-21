/**
 * «Servizi impattati» nel dettaglio incident (Servizi monitorati, ondata 3):
 * i servizi collegati all'incident da `Incident.impactedServices` — nome,
 * salute, punteggio d'impatto e link al dettaglio del servizio.
 *
 * Stessa forma della sezione «Allarmi di monitoraggio» (CorrelatedEventsSection):
 * una SectionCard con il conteggio. Sparisce del tutto quando non c'è nessun
 * servizio: un riquadro vuoto in ogni incident «manuale» sarebbe solo rumore.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import { colors } from '@/lib/tokens'
import { ServiceHealthBadge, ImpactScore } from '@/pages/monitoring/servicesShared'
import { servicePath } from '@/pages/monitoring/ServicesPage'
import type { ImpactedServiceRef } from '@/types/services'

export function ImpactedServicesSection({ services }: { services: ImpactedServiceRef[] }) {
  const { t } = useTranslation()
  if (services.length === 0) return null

  return (
    <SectionCard title={t('pages.incidents.impactedServices.title')} count={services.length} collapsible defaultOpen>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-table)', color: colors.slateLight }}>
        {t('pages.incidents.impactedServices.hint')}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {services.map((s) => (
          <li key={s.id} data-testid="impacted-service-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
            <Link
              to={servicePath(s.id)}
              title={t('pages.incidents.impactedServices.openService', { name: s.name })}
              style={{ color: colors.brand, textDecoration: 'none', fontWeight: 600 }}
            >
              {s.name}
            </Link>
            <ServiceHealthBadge health={s.health} />
            <ImpactScore score={s.impactScore} health={s.health} width={60} />
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
