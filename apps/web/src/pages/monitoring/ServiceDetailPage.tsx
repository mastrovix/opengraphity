/**
 * Dettaglio di un servizio monitorato: testata (nome, badge salute e stato,
 * punteggio d'impatto, «da», avviso se un componente non esiste più nella
 * CMDB), frase di spiegazione in parole, mappa a livelli con il percorso
 * d'impatto evidenziato (ServiceMapCanvas) e pannello del componente
 * selezionato, «Perché» (le cause con peso, critico e percorso), tabella
 * dei componenti (ServiceComponentsTable), cronologia (timeline), scheda
 * del servizio e «Come si calcola» (ServiceRulesCard).
 *
 * Azioni admin: «Rivaluta ora», «Aggiorna mappa» (dialogo del diff col
 * grafo), «Metti in pausa»/«Riattiva» (con `expectedVersion` = la versione
 * letta), «Elimina» (con conferma). Le mutation restituiscono la mappa
 * completa: la cache aggiorna la pagina.
 * Polling 15 s in pausa a scheda nascosta: la salute cambia da sola.
 *
 * Ondata 2: regole e componenti si modificano qui dentro (solo admin); per
 * gli altri ruoli i riquadri restano quelli di sola lettura, senza controlli.
 * Ondata 3: il riquadro «Incident aperto» (ServiceOpenIncidentCard) con
 * l'incident non chiuso che il monitoraggio ha aperto per il servizio.
 */
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Boxes, RotateCcw, Pause, Play, Trash2, AlertTriangle, Star, Loader2, X, ArrowRight, GitCompareArrows } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Pill } from '@/components/ui/Pill'
import { useMe } from '@/hooks/useMe'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { GET_SERVICE_MAP } from '@/graphql/queries'
import { REEVALUATE_SERVICE_MAP, SET_SERVICE_MAP_STATUS, DELETE_SERVICE_MAP } from '@/graphql/mutations'
import { formatDateTime, formatDuration, timeAgo } from '@/lib/datetime'
import { pausedWhenHidden } from '@/lib/polling'
import { ciPath } from '@/lib/ciPath'
import { ciTypeLabelKey, enumLabel } from '@/lib/ciEnums'
import { colors, palette } from '@/lib/tokens'
import { AMBER_BANNER, TINT_NEUTRAL, TINT_WARNING } from '@/lib/eventPalette'
import { ServiceMapCanvas } from './ServiceMapCanvas'
import { ServiceHistorySection } from './ServiceHistorySection'
import { ServiceComponentsTable } from './ServiceComponentsTable'
import { ServiceRulesCard } from './ServiceRulesCard'
import { ServiceOpenIncidentCard } from './ServiceOpenIncidentCard'
import { UpdateServiceMapDialog } from './UpdateServiceMapDialog'
import {
  ServiceHealthBadge, ServiceStatusPill, NodeHealthBadge, ImpactScore,
  causeSequenceLabel, explanationSentence, propagationLabel, roleLabel, serviceStatusLabel, serviceHealthLabel,
} from './servicesShared'
import type { ServiceMapDetail, ServiceMapNode, ImpactCause } from '@/types/services'

const POLL_MS = 15_000
const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

export function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isAdmin } = useMe()
  const confirm = useConfirm()
  const { ciTypes } = useMetamodel()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)

  const { data, previousData, loading, error, refetch } = useQuery<{ serviceMap: ServiceMapDetail | null }>(GET_SERVICE_MAP, {
    variables: { id }, fetchPolicy: 'cache-and-network', ...pausedWhenHidden(POLL_MS),
  })
  const [reevaluate, { loading: reevaluating }] = useMutation<{ reevaluateServiceMap: ServiceMapDetail }>(REEVALUATE_SERVICE_MAP)
  const [setStatus, { loading: settingStatus }] = useMutation<{ setServiceMapStatus: ServiceMapDetail }>(SET_SERVICE_MAP_STATUS)
  const [deleteMap, { loading: deleting }] = useMutation<{ deleteServiceMap: boolean }>(DELETE_SERVICE_MAP)

  if (loading && !data && !previousData) return <PageLoader />
  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  const map = (data ?? previousData)?.serviceMap
  if (!map) {
    return (
      <PageContainer>
        <EmptyState icon={<Boxes size={32} />} title={t('monitoring.services.detail.notFound')} action={<Button variant="secondary" onClick={() => navigate('/monitoring/services')}>{t('monitoring.services.detail.back')}</Button>} />
      </PageContainer>
    )
  }

  const ciTypeLabel = (type: string) => {
    const key = ciTypeLabelKey(type)
    return key ? t(key) : (ciTypes.find((ct) => ct.name === type)?.label ?? enumLabel(type))
  }
  const nodeById = new Map(map.nodes.map((n) => [n.ci.id, n]))
  const selected = selectedId ? (nodeById.get(selectedId) ?? null) : null
  const since = map.healthSince ? formatDuration(Date.now() - new Date(map.healthSince).getTime()) : null
  const busy = reevaluating || settingStatus || deleting

  async function onReevaluate() {
    try {
      const res = await reevaluate({ variables: { id } })
      const next = res.data?.reevaluateServiceMap
      if (!next) throw new Error(t('monitoring.services.detail.noResult', { operation: 'reevaluateServiceMap' }))
      toast.success(t('toast.services.reevaluated', { health: serviceHealthLabel(t, next.health) }))
    } catch (e) { toast.error(t('toast.services.actionFailed', { error: errorMessage(e) })) }
  }

  async function onToggleStatus() {
    if (!map) return
    const status = map.status === 'paused' ? 'active' : 'paused'
    try {
      const res = await setStatus({ variables: { id, expectedVersion: map.version, status } })
      const next = res.data?.setServiceMapStatus
      if (!next) throw new Error(t('monitoring.services.detail.noResult', { operation: 'setServiceMapStatus' }))
      toast.success(t('toast.services.statusChanged', { status: serviceStatusLabel(t, next.status) }))
    } catch (e) { toast.error(t('toast.services.actionFailed', { error: errorMessage(e) })) }
  }

  async function onDelete() {
    if (!map) return
    const ok = await confirm({ title: t('monitoring.services.delete.title', { name: map.name }), body: t('monitoring.services.delete.body'), danger: true, confirmLabel: t('common.delete') })
    if (!ok) return
    try {
      await deleteMap({ variables: { id } })
      toast.success(t('toast.services.deleted'))
      navigate('/monitoring/services')
    } catch (e) { toast.error(t('toast.services.actionFailed', { error: errorMessage(e) })) }
  }

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <button type="button" onClick={() => navigate('/monitoring/services')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--font-size-card-title)', padding: 0 }}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('monitoring.services.detail.back')}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: colors.slateDark, letterSpacing: '-0.01em', margin: 0 }}>{map.name}</h1>
          <ServiceHealthBadge health={map.health} />
          <ServiceStatusPill status={map.status} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
          <ImpactScore score={map.impactScore} health={map.health} width={120} />
          {since && <span title={t('monitoring.services.sinceHint', { date: formatDateTime(map.healthSince) })}>{t('monitoring.services.since', { duration: since })}</span>}
          <span>{map.evaluatedAt ? t('monitoring.services.detail.evaluated', { ago: timeAgo(map.evaluatedAt) }) : t('monitoring.services.detail.neverEvaluated')}</span>
        </div>
        {map.stale && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '10px 14px', borderRadius: 8, background: AMBER_BANNER.bg, border: `1px solid ${AMBER_BANNER.border}`, color: AMBER_BANNER.text, fontSize: 'var(--font-size-body)' }}>
            <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
            {t('monitoring.services.stale')}
          </div>
        )}
        <p data-testid="explanation-sentence" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-card-title)', color: colors.slateDark, lineHeight: 1.6 }}>
          {explanationSentence(t, map)}
        </p>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <Button variant="secondary" size="sm" disabled={busy} icon={reevaluating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />} onClick={() => void onReevaluate()}>
              {t('monitoring.services.detail.actions.reevaluate')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} icon={<GitCompareArrows size={14} aria-hidden="true" />} onClick={() => setUpdateOpen(true)}>
              {t('monitoring.services.detail.actions.updateMap')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} icon={map.status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />} onClick={() => void onToggleStatus()}>
              {map.status === 'paused' ? t('monitoring.services.detail.actions.resume') : t('monitoring.services.detail.actions.pause')}
            </Button>
            <Button variant="danger" size="sm" disabled={busy} icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => void onDelete()}>
              {t('monitoring.services.detail.actions.delete')}
            </Button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
        <div>
          <SectionCard title={t('monitoring.services.detail.map')} count={map.nodeCount} defaultOpen>
            <ServiceMapCanvas map={map} selectedId={selectedId} onSelect={setSelectedId} />
          </SectionCard>

          <SectionCard title={t('monitoring.services.detail.why')} count={map.explanation.length} defaultOpen>
            {map.explanation.length === 0
              ? <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('monitoring.services.detail.whyEmpty')}</p>
              : (
                <ol data-testid="why-list" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {map.explanation.map((c) => <CauseRow key={c.ci.id} cause={c} serviceName={map.service.name} typeLabel={ciTypeLabel(c.ci.type)} onSelect={setSelectedId} />)}
                </ol>
              )}
          </SectionCard>

          <SectionCard title={t('monitoring.services.detail.components')} count={map.nodeCount} defaultOpen>
            <ServiceComponentsTable map={map} canEdit={isAdmin} ciTypeLabel={ciTypeLabel} onReload={() => void refetch()} />
          </SectionCard>

          <ServiceHistorySection entries={map.history} total={map.historyCount} />
        </div>

        <div>
          {selected && <NodePanel node={selected} typeLabel={ciTypeLabel(selected.ci.type)} onClose={() => setSelectedId(null)} />}

          {/* Incident aperto dal monitoraggio per questo servizio (ondata 3). */}
          <ServiceOpenIncidentCard incident={map.openIncident} openIncidentFrom={map.rules.openIncidentFrom} />

          <SectionCard title={t('monitoring.services.detail.service')} defaultOpen>
            <DetailField label={t('monitoring.services.detail.fields.service')} value={map.service.name} />
            <DetailField label={t('monitoring.services.detail.fields.criticality')} value={map.service.criticality ? enumLabel(map.service.criticality) : null} />
            <DetailField label={t('monitoring.services.detail.fields.owner')} value={map.service.ownerGroup?.name ?? null} />
            <DetailField label={t('monitoring.services.detail.fields.status')} value={<ServiceStatusPill status={map.status} />} />
            <DetailField label={t('monitoring.services.detail.fields.version')} value={String(map.version)} />
            <DetailField label={t('monitoring.services.detail.fields.maxDepth')} value={String(map.maxDepth)} />
            <DetailField label={t('monitoring.services.detail.fields.relationshipTypes')} value={map.relationshipTypes.length > 0 ? map.relationshipTypes.join(', ') : null} />
            <DetailField label={t('monitoring.services.detail.fields.builtFrom')} value={builtFromLabel(map.builtFrom, t)} />
            <DetailField label={t('monitoring.services.detail.fields.excluded')} value={t('monitoring.services.detail.fields.excludedCount', { count: map.excluded.length })} />
            <DetailField label={t('monitoring.services.detail.fields.updatedAt')} value={map.updatedAt ? `${formatDateTime(map.updatedAt)} · ${timeAgo(map.updatedAt)}` : null} />
            <DetailField label={t('monitoring.services.detail.fields.evaluatedAt')} value={map.evaluatedAt ? `${formatDateTime(map.evaluatedAt)} · ${timeAgo(map.evaluatedAt)}` : null} />
          </SectionCard>

          <ServiceRulesCard map={map} canEdit={isAdmin} onReload={() => void refetch()} />
        </div>
      </div>

      {isAdmin && <UpdateServiceMapDialog map={map} open={updateOpen} onClose={() => setUpdateOpen(false)} />}
    </PageContainer>
  )
}

type TFn = ReturnType<typeof useTranslation>['t']

/** Origine della mappa; un valore fuori vocabolario è mostrato in chiaro. */
function builtFromLabel(value: string, t: TFn): string {
  if (value === 'auto')   return t('monitoring.services.detail.fields.builtFromAuto')
  if (value === 'manual') return t('monitoring.services.detail.fields.builtFromManual')
  return t('monitoring.services.health.outOfVocabulary', { value })
}

/** Una causa nel pannello «Perché»: nome (seleziona il nodo sulla mappa), salute, peso, critico, percorso fino al servizio. */
function CauseRow({ cause, serviceName, typeLabel, onSelect }: { cause: ImpactCause; serviceName: string; typeLabel: string; onSelect: (id: string) => void }) {
  const { t } = useTranslation()
  return (
    <li data-testid="why-cause" data-ci-id={cause.ci.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', borderRadius: 8, background: palette.neutral.surface1, border: `1px solid ${colors.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
        {/* Il nome accessibile contiene il testo visibile («Evidenzia db-01 sulla mappa»): il title da solo non conterebbe. */}
        <button type="button" onClick={() => onSelect(cause.ci.id)} aria-label={t('monitoring.services.why.select', { name: cause.ci.name })} title={t('monitoring.services.why.select', { name: cause.ci.name })} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: colors.brand, cursor: 'pointer' }}>
          {cause.ci.name}
        </button>
        <span style={{ color: colors.slateLight }}>{typeLabel}</span>
        <NodeHealthBadge health={cause.health} />
        <Pill bg={TINT_NEUTRAL.bg} color={TINT_NEUTRAL.color} style={{ fontSize: 'var(--font-size-label)' }}>{t('monitoring.services.why.weight', { weight: cause.weight })}</Pill>
        {cause.critical && (
          <Pill bg={TINT_WARNING.bg} color={TINT_WARNING.color} style={{ fontSize: 'var(--font-size-label)', gap: 4 }}>
            <Star size={10} aria-hidden="true" />{t('monitoring.services.why.critical')}
          </Pill>
        )}
      </div>
      <div style={{ fontSize: 'var(--font-size-table)', color: colors.slate }}>
        <span>{t('monitoring.services.why.path')}: </span>
        <span data-testid="why-path">{causeSequenceLabel(cause, serviceName)}</span>
      </div>
    </li>
  )
}

/** Pannello laterale del componente selezionato sulla mappa. */
function NodePanel({ node, typeLabel, onClose }: { node: ServiceMapNode; typeLabel: string; onClose: () => void }) {
  const { t } = useTranslation()
  const yesNo = (v: boolean) => (v ? t('common.yes') : t('common.no'))
  const consoleLink = `/events?ciId=${encodeURIComponent(node.ci.id)}`
  return (
    <SectionCard
      title={t('monitoring.services.detail.node')}
      defaultOpen
      headerRight={
        <button type="button" onClick={onClose} aria-label={t('monitoring.services.detail.closeNode')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.white, padding: 4, display: 'inline-flex' }}>
          <X size={16} aria-hidden="true" />
        </button>
      }
    >
      <div data-testid="node-panel" data-ci-id={node.ci.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <DetailField label={t('monitoring.services.detail.nodeFields.name')} value={<Link to={ciPath(node.ci)} style={linkStyle}>{node.ci.name}</Link>} />
        </div>
        <DetailField label={t('monitoring.services.detail.nodeFields.type')} value={typeLabel} />
        <DetailField label={t('monitoring.services.detail.nodeFields.level')} value={String(node.level)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.role')} value={roleLabel(t, node.role)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.propagate')} value={propagationLabel(t, node.propagate)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.weight')} value={String(node.weight)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.critical')} value={yesNo(node.critical)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.health')} value={<NodeHealthBadge health={node.health} />} />
        <DetailField label={t('monitoring.services.detail.nodeFields.inMaintenance')} value={yesNo(node.inMaintenance)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.contributes')} value={yesNo(node.contributes)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.addedBy')} value={addedByLabel(node.addedBy, t)} />
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
          <Link to={consoleLink} style={{ ...linkStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t('monitoring.services.detail.nodeFields.alarms')} <ArrowRight size={11} aria-hidden="true" />
          </Link>
          <Link to={ciPath(node.ci)} style={{ ...linkStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t('monitoring.services.detail.nodeFields.openCI')} <ArrowRight size={11} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </SectionCard>
  )
}

function addedByLabel(value: string, t: TFn): string {
  if (value === 'auto')   return t('monitoring.services.detail.nodeFields.addedByAuto')
  if (value === 'manual') return t('monitoring.services.detail.nodeFields.addedByManual')
  return t('monitoring.services.health.outOfVocabulary', { value })
}
