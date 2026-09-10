/**
 * Dettaglio di un allarme: campi, etichette (JSON → tabella chiave/valore),
 * CI riconosciuto con stato (ciclo di vita) e salute (monitoraggio), sorgente,
 * incident correlato, presa in carico,
 * azioni (operator/admin) e la sezione "Alias del CI" (elimina/aggiungi: admin,
 * CIAliasesSection condivisa con il dettaglio CI).
 * Ondata 3: la sezione "Correlazione" spiega in una frase cosa ha fatto la
 * policy (incident aperto/agganciato, silenziato da una change, in attesa,
 * CI da collegare, sotto soglia) con i link e i pulsanti "Rivaluta ora" /
 * "Apri incident". Ondata 4: frasi per sfarfallio e tempesta, campi
 * "Instabile dal" e "Passaggi nelle ultime 24 h".
 * Ondata 5: tipo/stato del CI, tipo di risorsa e strumento con le etichette
 * dell'app (non i valori grezzi); motivo del riconoscimento del CI
 * (`matchReason`, con l'aiuto "collega a mano o aggiungi un alias" se
 * ambiguo), severità massima del ciclo (`maxSeverity`, se diversa da quella
 * attuale) e ID esterno della risorsa (`resourceExternalId`); l'incident è
 * linkato una volta sola (Contesto), la frase di correlazione lo cita.
 * Cronologia: la sezione "Cronologia" (EventHistorySection) elenca le voci di
 * `history` dalla più recente; le azioni della pagina rileggono l'evento
 * (`refetch`) così la voce appena scritta compare subito.
 */
import { useId } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Radar, GitBranch } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Pill } from '@/components/ui/Pill'
import { useMe } from '@/hooks/useMe'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { GET_EVENT, GET_EVENT_POLICY } from '@/graphql/queries'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { ciTypeLabelKey, enumLabel } from '@/lib/ciEnums'
import { colors } from '@/lib/tokens'
import { TINT_NEUTRAL } from '@/lib/eventPalette'
import { ToolBadge } from '@/pages/monitoring/monitoringShared'
import { EventStatusBadge, EventSeverityBadge, EventNoCIBadge, CIHealthBadge, parseLabels, matchReasonLabel, resourceKindLabel } from './eventShared'
import { correlationSentence } from './eventCorrelation'
import { EventActions } from './EventActions'
import { CIAliasesSection } from './CIAliasesSection'
import { EventHistorySection } from './EventHistorySection'
import type { MonitoringEventDetail, EventPolicy } from '@/types/events'

const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { role, isAdmin } = useMe()
  const { ciTypes } = useMetamodel()
  const canAct = role === 'admin' || role === 'operator'
  const matchHelpId = useId()

  const { data, loading, error, refetch } = useQuery<{ event: MonitoringEventDetail | null }>(GET_EVENT, {
    variables: { id }, fetchPolicy: 'cache-and-network',
  })
  // Policy: dà i numeri alle frasi "in attesa" e "sotto soglia"; senza, la frase resta generica.
  const { data: policyData } = useQuery<{ eventPolicy: EventPolicy }>(GET_EVENT_POLICY, { fetchPolicy: 'cache-first' })
  const policy = policyData?.eventPolicy ?? null

  if (loading && !data) return <PageLoader />
  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  const ev = data?.event
  if (!ev) {
    return (
      <PageContainer>
        <EmptyState icon={<Radar size={32} />} title={t('events.detail.notFound')} action={<Button variant="secondary" onClick={() => navigate('/events')}>{t('events.detail.back')}</Button>} />
      </PageContainer>
    )
  }

  const labels = parseLabels(ev.labels, t)
  const kindLabel = resourceKindLabel(t, ev.resourceKind)
  // Tipo del CI: etichetta fissa dei tipi storici, altrimenti quella del metamodello, altrimenti il nome leggibile.
  const ciTypeLabel = (type: string) => {
    const key = ciTypeLabelKey(type)
    return key ? t(key) : (ciTypes.find((ct) => ct.name === type)?.label ?? enumLabel(type))
  }
  const ambiguous = ev.matchReason === 'ambiguous' && !ev.ci
  // La severità massima del ciclo conta solo se diversa da quella attuale (altrimenti è già scritta sopra).
  const peak = ev.maxSeverity && ev.maxSeverity !== ev.severity ? ev.maxSeverity : null

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <button type="button" onClick={() => navigate('/events')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--font-size-card-title)', padding: 0 }}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('events.detail.back')}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: colors.slateDark, letterSpacing: '-0.01em', margin: 0 }}>{ev.title}</h1>
          <EventStatusBadge status={ev.status} severity={ev.severity} />
          <EventSeverityBadge severity={ev.severity} />
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{kindLabel} · {ev.resource}</div>
        {canAct && (
          <div style={{ marginTop: 16 }}>
            <EventActions event={ev} size="sm" exclude={['reevaluate', 'openIncident']} onChanged={() => void refetch()} />
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
        <div>
          <SectionCard title={t('events.correlation.title')} defaultOpen>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <GitBranch size={16} color={colors.slateLight} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
              <p data-testid="correlation-sentence" style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.6 }}>
                {correlationSentence(t, ev, policy)}
              </p>
            </div>
            {ev.suppressedBy && (
              <div style={{ fontSize: 'var(--font-size-body)' }}>
                <span style={{ color: colors.slateLight, marginRight: 6 }}>{t('events.correlation.suppressedByLabel')}:</span>
                <Link to={`/changes/${ev.suppressedBy.id}`} style={linkStyle}>{ev.suppressedBy.code} · {ev.suppressedBy.title}</Link>
              </div>
            )}
            {canAct && <EventActions event={ev} size="xs" only={['reevaluate', 'openIncident']} onChanged={() => void refetch()} />}
          </SectionCard>

          <SectionCard title={t('events.detail.information')} defaultOpen>
            <DetailField label={t('events.detail.description')} value={ev.description} />
            <DetailField label={t('events.detail.resource')} value={`${ev.resource} (${kindLabel})`} />
            <DetailField label={t('events.detail.fingerprint')} value={ev.fingerprint} mono />
            {ev.externalId && <DetailField label={t('events.detail.externalId')} value={ev.externalId} mono />}
            {ev.resourceExternalId && <DetailField label={t('events.detail.resourceExternalId')} value={ev.resourceExternalId} mono />}
            {peak && <DetailField label={t('events.detail.maxSeverity')} value={<EventSeverityBadge severity={peak} />} />}
            <DetailField label={t('events.columns.count')} value={String(ev.count)} />
            <DetailField label={t('events.detail.firstSeen')} value={formatDateTime(ev.firstSeenAt)} />
            <DetailField label={t('events.detail.lastSeen')} value={`${formatDateTime(ev.lastSeenAt)} · ${timeAgo(ev.lastSeenAt)}`} />
            {ev.resolvedAt && <DetailField label={t('events.detail.resolvedAt')} value={formatDateTime(ev.resolvedAt)} />}
            {ev.flappingSince && <DetailField label={t('events.detail.flappingSince')} value={`${formatDateTime(ev.flappingSince)} · ${timeAgo(ev.flappingSince)}`} />}
            {ev.transitions24h > 0 && <DetailField label={t('events.detail.transitions24h')} value={String(ev.transitions24h)} />}
            <DetailField
              label={t('events.detail.acknowledged')}
              value={ev.acknowledgedBy
                ? t('events.detail.acknowledgedBy', { name: ev.acknowledgedBy.name, when: formatDateTime(ev.acknowledgedAt) })
                : t('events.detail.notAcknowledged')}
            />
          </SectionCard>

          <EventHistorySection entries={ev.history} total={ev.historyCount} />

          <SectionCard title={t('events.detail.labels')} count={labels.entries.length} defaultOpen>
            {labels.error && <p role="alert" style={{ color: colors.danger, fontSize: 'var(--font-size-body)', margin: 0 }}>{t('events.detail.labelsInvalid', { error: labels.error })}</p>}
            {!labels.error && labels.entries.length === 0 && <p style={{ color: colors.slateLight, fontSize: 'var(--font-size-body)', margin: 0 }}>{t('events.detail.noLabels')}</p>}
            {labels.entries.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'left', padding: '4px 8px', color: colors.slateLight, fontWeight: 500, fontSize: 'var(--font-size-label)', textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}` }}>{t('events.detail.labelKey')}</th>
                    <th scope="col" style={{ textAlign: 'left', padding: '4px 8px', color: colors.slateLight, fontWeight: 500, fontSize: 'var(--font-size-label)', textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}` }}>{t('events.detail.labelValue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {labels.entries.map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: colors.slate, borderBottom: '1px solid var(--color-border-light)', whiteSpace: 'nowrap' }}>{k}</td>
                      <td style={{ padding: '6px 8px', color: colors.slateDark, borderBottom: '1px solid var(--color-border-light)', wordBreak: 'break-all' }}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>
        </div>

        <div>
          <SectionCard title={t('events.detail.context')} defaultOpen>
            <DetailField
              label={t('events.columns.ci')}
              value={ev.ci
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Link to={ciPath(ev.ci)} style={linkStyle}>{ev.ci.name}</Link>
                    <span style={{ color: colors.slateLight }}>{ciTypeLabel(ev.ci.type)}</span>
                    {ev.ci.status && <Pill bg={TINT_NEUTRAL.bg} color={TINT_NEUTRAL.color} style={{ fontSize: 'var(--font-size-label)' }}>{enumLabel(ev.ci.status)}</Pill>}
                    {ev.ci.health && <CIHealthBadge health={ev.ci.health} />}
                  </span>
                : <EventNoCIBadge matchReason={ev.matchReason} />}
            />
            <DetailField
              label={t('events.detail.matchReason')}
              value={
                <span aria-describedby={ambiguous ? matchHelpId : undefined}>
                  {matchReasonLabel(t, ev.matchReason)}
                  {ambiguous && (
                    <span id={matchHelpId} style={{ display: 'block', fontSize: 'var(--font-size-table)', color: colors.slate, marginTop: 2 }}>
                      {t('events.matchReason.ambiguousHelp')}
                    </span>
                  )}
                </span>
              }
            />
            <DetailField
              label={t('events.columns.source')}
              value={ev.source
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span>{ev.source.name}</span>
                    <ToolBadge kind={ev.source.connectorKind} />
                  </span>
                : null}
            />
            <DetailField
              label={t('events.columns.incident')}
              value={ev.incident
                ? <Link to={`/incidents/${ev.incident.id}`} style={linkStyle}>{ev.incident.number} · {ev.incident.title}</Link>
                : null}
            />
          </SectionCard>

          {ev.ci && <CIAliasesSection ci={ev.ci} canEdit={isAdmin} variant="card" />}
        </div>
      </div>
    </PageContainer>
  )
}
