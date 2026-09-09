/**
 * Dettaglio di un evento: campi, etichette (JSON → tabella chiave/valore),
 * CI riconosciuto con stato (ciclo di vita) e salute (monitoraggio), sorgente,
 * incident correlato, presa in carico,
 * azioni (operator/admin) e la sezione "Alias del CI" (elimina/aggiungi: admin).
 * Ondata 3: la sezione "Correlazione" spiega in una frase cosa ha fatto la
 * policy (incident aperto/agganciato, silenziato da una change, in attesa,
 * CI da collegare, sotto soglia) con i link e i pulsanti "Rivaluta ora" /
 * "Apri incident".
 */
import { useId, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Radar, Trash2, Plus, Loader2, GitBranch } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Pill } from '@/components/ui/Pill'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { useMe } from '@/hooks/useMe'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_EVENT, GET_CI_ALIASES, GET_EVENT_POLICY } from '@/graphql/queries'
import { CREATE_CI_ALIAS, DELETE_CI_ALIAS } from '@/graphql/mutations'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { EventStatusBadge, EventSeverityBadge, CIHealthBadge, parseLabels } from './eventShared'
import { correlationSentence } from './eventCorrelation'
import { EventActions } from './EventActions'
import { CI_ALIAS_KINDS, type MonitoringEvent, type CIAlias, type CIAliasKind, type ConfigurationItemRef, type EventPolicy } from '@/types/events'

const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { role, isAdmin } = useMe()
  const canAct = role === 'admin' || role === 'operator'

  const { data, loading, error, refetch } = useQuery<{ event: MonitoringEvent | null }>(GET_EVENT, {
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

  const labels = parseLabels(ev.labels)

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
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{ev.resourceKind} · {ev.resource}</div>
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
            {(ev.incident || ev.suppressedBy) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 'var(--font-size-body)' }}>
                {ev.incident && (
                  <span>
                    <span style={{ color: colors.slateLight, marginRight: 6 }}>{t('events.columns.incident')}:</span>
                    <Link to={`/incidents/${ev.incident.id}`} style={linkStyle}>{ev.incident.number} · {ev.incident.title}</Link>
                  </span>
                )}
                {ev.suppressedBy && (
                  <span>
                    <span style={{ color: colors.slateLight, marginRight: 6 }}>{t('events.correlation.suppressedByLabel')}:</span>
                    <Link to={`/changes/${ev.suppressedBy.id}`} style={linkStyle}>{ev.suppressedBy.code} · {ev.suppressedBy.title}</Link>
                  </span>
                )}
              </div>
            )}
            {canAct && <EventActions event={ev} size="xs" only={['reevaluate', 'openIncident']} onChanged={() => void refetch()} />}
          </SectionCard>

          <SectionCard title={t('events.detail.information')} defaultOpen>
            <DetailField label={t('events.detail.description')} value={ev.description} />
            <DetailField label={t('events.detail.resource')} value={`${ev.resource} (${ev.resourceKind})`} />
            <DetailField label={t('events.detail.fingerprint')} value={ev.fingerprint} mono />
            {ev.externalId && <DetailField label={t('events.detail.externalId')} value={ev.externalId} mono />}
            <DetailField label={t('events.columns.count')} value={String(ev.count)} />
            <DetailField label={t('events.detail.firstSeen')} value={formatDateTime(ev.firstSeenAt)} />
            <DetailField label={t('events.detail.lastSeen')} value={`${formatDateTime(ev.lastSeenAt)} · ${timeAgo(ev.lastSeenAt)}`} />
            {ev.resolvedAt && <DetailField label={t('events.detail.resolvedAt')} value={formatDateTime(ev.resolvedAt)} />}
            <DetailField
              label={t('events.detail.acknowledged')}
              value={ev.acknowledgedBy
                ? t('events.detail.acknowledgedBy', { name: ev.acknowledgedBy.name, when: formatDateTime(ev.acknowledgedAt) })
                : t('events.detail.notAcknowledged')}
            />
          </SectionCard>

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
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: colors.slate, borderBottom: '1px solid #f1f3f9', whiteSpace: 'nowrap' }}>{k}</td>
                      <td style={{ padding: '6px 8px', color: colors.slateDark, borderBottom: '1px solid #f1f3f9', wordBreak: 'break-all' }}>{v}</td>
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
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Link to={ciPath(ev.ci)} style={linkStyle}>{ev.ci.name}</Link>
                    <span style={{ color: colors.slateLight }}>{ev.ci.type}</span>
                    {ev.ci.status && <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" style={{ fontSize: 'var(--font-size-label)' }}>{ev.ci.status}</Pill>}
                    {ev.ci.health && <CIHealthBadge health={ev.ci.health} />}
                  </span>
                : <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" style={{ fontSize: 'var(--font-size-label)' }}>{t('events.orphan')}</Pill>}
            />
            <DetailField
              label={t('events.columns.source')}
              value={ev.source ? `${ev.source.name}${ev.source.connectorKind ? ` (${ev.source.connectorKind})` : ''}` : null}
            />
            <DetailField
              label={t('events.columns.incident')}
              value={ev.incident
                ? <Link to={`/incidents/${ev.incident.id}`} style={linkStyle}>{ev.incident.number} · {ev.incident.title}</Link>
                : null}
            />
          </SectionCard>

          {ev.ci && <CIAliasesSection ci={ev.ci} canEdit={isAdmin} />}
        </div>
      </div>
    </PageContainer>
  )
}

// ── Alias del CI ─────────────────────────────────────────────────────────────

function CIAliasesSection({ ci, canEdit }: { ci: ConfigurationItemRef; canEdit: boolean }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const kindId = useId()
  const valueId = useId()
  const [kind, setKind] = useState<CIAliasKind>('hostname')
  const [value, setValue] = useState('')

  const { data, loading, error, refetch } = useQuery<{ ciAliases: CIAlias[] }>(GET_CI_ALIASES, { variables: { ciId: ci.id } })
  const [deleteAlias] = useMutation(DELETE_CI_ALIAS)
  const [createAlias, { loading: creating }] = useMutation(CREATE_CI_ALIAS)
  const aliases = data?.ciAliases ?? []

  async function handleDelete(alias: CIAlias) {
    const ok = await confirm({ title: t('events.aliases.deleteTitle'), body: `${alias.kind}: ${alias.value}`, danger: true })
    if (!ok) return
    try {
      await deleteAlias({ variables: { id: alias.id } })
      toast.success(t('toast.events.aliasDeleted'))
      void refetch()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  async function handleCreate() {
    const v = value.trim()
    if (!v) return
    try {
      await createAlias({ variables: { ciId: ci.id, kind, value: v } })
      toast.success(t('toast.events.aliasCreated'))
      setValue('')
      void refetch()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  return (
    <SectionCard title={t('events.aliases.title', { ci: ci.name })} count={aliases.length} defaultOpen>
      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {!error && loading && !data && <p style={{ color: colors.slateLight, fontSize: 'var(--font-size-body)', margin: 0 }}>{t('common.loading')}</p>}
      {!error && data && aliases.length === 0 && <p style={{ color: colors.slateLight, fontSize: 'var(--font-size-body)', margin: 0 }}>{t('events.aliases.empty')}</p>}
      {aliases.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {aliases.map((a) => (
            <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)' }}>
              <Pill bg="var(--color-info-bg)" color="#2563eb" style={{ fontSize: 'var(--font-size-label)' }}>{t(`events.aliases.kind.${a.kind}`)}</Pill>
              <span style={{ fontFamily: 'monospace', color: colors.slateDark, wordBreak: 'break-all' }}>{a.value}</span>
              <span style={{ color: colors.slateLight, marginLeft: 'auto', whiteSpace: 'nowrap' }} title={formatDateTime(a.createdAt)}>{a.source}</span>
              {canEdit && (
                <Button variant="danger" size="xs" aria-label={t('events.aliases.delete', { value: a.value })} title={t('common.delete')} onClick={() => void handleDelete(a)} style={{ padding: 4 }}>
                  <Trash2 size={13} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 8, borderTop: `1px solid ${colors.border}` }}>
          <div style={{ flex: '0 0 130px' }}>
            <FieldLabel htmlFor={kindId}>{t('events.aliases.kindLabel')}</FieldLabel>
            <Select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as CIAliasKind)} disabled={creating}>
              {CI_ALIAS_KINDS.map((k) => <option key={k} value={k}>{t(`events.aliases.kind.${k}`)}</option>)}
            </Select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <FieldLabel htmlFor={valueId}>{t('events.aliases.valueLabel')}</FieldLabel>
            <Input id={valueId} value={value} onChange={(e) => setValue(e.target.value)} disabled={creating} placeholder={t('events.aliases.valuePlaceholder')} />
          </div>
          <Button size="xs" disabled={creating || !value.trim()} icon={creating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />} onClick={() => void handleCreate()}>
            {t('events.aliases.add')}
          </Button>
        </div>
      )}
    </SectionCard>
  )
}
