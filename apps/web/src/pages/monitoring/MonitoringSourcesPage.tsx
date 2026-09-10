/**
 * Sorgenti di monitoraggio (admin): gli InboundWebhook con entityType = event.
 * Elenco con strumento, stato (toggle), ultimo ricevuto, contatori, ultimo
 * errore in chiaro e azioni: modifica, rigenera token (mostrato UNA volta),
 * invia evento di prova, elimina. Stato vuoto che porta alla procedura guidata.
 * Ondata 4: badge ambra "Tempesta" sulla riga della sorgente che sta mandando
 * troppi allarmi al minuto (`eventStats.stormSources`, polling 15 s).
 * Revisione D·1.11: anche l'elenco è in polling (stesso ritmo, in pausa a
 * scheda nascosta) con il pulsante "Aggiorna"; dopo "Invia evento di prova"
 * un secondo refetch arriva qualche secondo dopo, quando il job ha elaborato.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Radar, Plus, Pencil, KeyRound, Send, Trash2, AlertTriangle, CloudLightning, RefreshCw } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Toggle } from '@/components/ui/Toggle'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_MONITORING_SOURCES, GET_EVENT_STATS } from '@/graphql/queries'
import { UPDATE_MONITORING_SOURCE, DELETE_MONITORING_SOURCE, REGENERATE_SOURCE_TOKEN, SEND_SAMPLE_EVENT } from '@/graphql/mutations'
import { timeAgo, formatDateTime, currentLocale } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { pausedWhenHidden } from '@/lib/polling'
import { Pill } from '@/components/ui/Pill'
import type { MonitoringSource, EventStats, StormSource } from '@/types/events'
import { ToolBadge, EnabledPill, SecretBox } from './monitoringShared'

/** Polling dell'elenco e dei contatori (badge "Tempesta"), in pausa a scheda nascosta. */
const SOURCES_POLL_MS = 15_000
/** Attesa prima del refetch dopo l'evento di prova: il job lo elabora in modo asincrono. */
export const SAMPLE_REFETCH_DELAY_MS = 2500

interface Props {
  /** Solo per i test: attesa prima del refetch dopo l'evento di prova. */
  sampleRefetchDelayMs?: number
}

/** Badge "Tempesta" con tooltip: tasso, da che ora, incident di tempesta. */
function StormBadge({ storm }: { storm: StormSource }) {
  const { t } = useTranslation()
  const time = new Date(storm.since).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })
  const tip = storm.incidentNumber
    ? t('monitoring.sources.stormBadgeHint', { rate: storm.ratePerMinute, time, number: storm.incidentNumber })
    : t('monitoring.sources.stormBadgeHintNoIncident', { rate: storm.ratePerMinute, time })
  return (
    <Pill bg="#fef3c7" color="#b45309" style={{ fontSize: 'var(--font-size-label)', gap: 4 }}>
      <span title={tip} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <CloudLightning size={11} aria-hidden="true" />
        {t('monitoring.sources.stormBadge')}
      </span>
    </Pill>
  )
}

export function MonitoringSourcesPage({ sampleRefetchDelayMs = SAMPLE_REFETCH_DELAY_MS }: Props = {}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null)

  const { data, loading, error, refetch } = useQuery<{ monitoringSources: MonitoringSource[] }>(GET_MONITORING_SOURCES, { fetchPolicy: 'cache-and-network', ...pausedWhenHidden(SOURCES_POLL_MS) })
  const sources = data?.monitoringSources ?? []

  // Sorgenti in tempesta: badge sulla riga. Se la query fallisce il badge
  // manca e basta: l'elenco delle sorgenti non dipende dai contatori.
  const { data: statsData } = useQuery<{ eventStats: EventStats }>(GET_EVENT_STATS, { fetchPolicy: 'cache-and-network', ...pausedWhenHidden(SOURCES_POLL_MS) })

  // Refetch ritardato dopo l'evento di prova; il timer muore con la pagina.
  const sampleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (sampleTimer.current) clearTimeout(sampleTimer.current) }, [])
  const stormBySource = useMemo(() => new Map((statsData?.eventStats.stormSources ?? []).map((s) => [s.sourceId, s])), [statsData])

  const [updateSource] = useMutation(UPDATE_MONITORING_SOURCE)
  const [deleteSource] = useMutation(DELETE_MONITORING_SOURCE)
  const [regenToken]   = useMutation<{ regenerateWebhookToken: { id: string; token: string } }>(REGENERATE_SOURCE_TOKEN)
  const [sendSample]   = useMutation<{ sendSampleEvent: number }>(SEND_SAMPLE_EVENT)

  async function handleToggle(s: MonitoringSource, enabled: boolean) {
    try {
      await updateSource({ variables: { id: s.id, input: { enabled } } })
      toast.success(t('toast.monitoring.sourceUpdated'))
      void refetch()
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  async function handleDelete(s: MonitoringSource) {
    const ok = await confirm({ title: t('monitoring.sources.deleteTitle', { name: s.name }), body: t('monitoring.sources.deleteBody'), danger: true, confirmLabel: t('common.delete') })
    if (!ok) return
    try {
      await deleteSource({ variables: { id: s.id } })
      toast.success(t('toast.monitoring.sourceDeleted'))
      void refetch()
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  async function handleRegen(s: MonitoringSource) {
    const ok = await confirm({ title: t('monitoring.sources.regenTitle'), body: t('monitoring.sources.regenBody'), danger: true, confirmLabel: t('monitoring.sources.regenToken') })
    if (!ok) return
    try {
      const res = await regenToken({ variables: { id: s.id } })
      const token = res.data?.regenerateWebhookToken.token
      if (!token) throw new Error(t('monitoring.errors.tokenMissing', { operation: 'regenerateWebhookToken' }))
      toast.success(t('toast.monitoring.tokenRegenerated'))
      setNewToken({ name: s.name, token })
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  async function handleSample(s: MonitoringSource) {
    try {
      await sendSample({ variables: { sourceId: s.id } })
      toast.success(t('toast.monitoring.sampleSent'), { action: { label: t('monitoring.wizard.openConsole'), onClick: () => navigate(`/events?sourceId=${s.id}`) } })
      // Subito il refetch non vedrebbe nulla: "Ricevuti"/"Errori" cambiano quando il job ha elaborato l'evento.
      if (sampleTimer.current) clearTimeout(sampleTimer.current)
      sampleTimer.current = setTimeout(() => { void refetch() }, sampleRefetchDelayMs)
    } catch (e) { toast.error(t('toast.monitoring.sampleFailed', { error: errorMessage(e) })) }
  }

  const columns: ColumnDef<MonitoringSource>[] = [
    {
      key: 'name', label: t('monitoring.sources.columns.name'), sortable: true,
      render: (_v, row) => {
        const storm = stormBySource.get(row.id)
        return (
          <div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Link to={`/monitoring/sources/${row.id}`} onClick={(e) => e.stopPropagation()} style={{ color: colors.brand, textDecoration: 'none', fontWeight: 600 }}>{row.name}</Link>
              {storm && <StormBadge storm={storm} />}
            </span>
            {!row.enabled && <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{t('monitoring.sources.disabledHint')}</div>}
          </div>
        )
      },
    },
    { key: 'connectorKind', label: t('monitoring.sources.columns.tool'), width: '180px', sortable: true, render: (_v, row) => <ToolBadge kind={row.connectorKind} /> },
    {
      key: 'enabled', label: t('monitoring.sources.columns.status'), width: '140px', sortable: true,
      render: (_v, row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Toggle size="sm" checked={row.enabled} onChange={(v) => void handleToggle(row, v)} label={t('monitoring.sources.toggle', { name: row.name })} />
          <EnabledPill enabled={row.enabled} />
        </span>
      ),
    },
    {
      key: 'lastReceivedAt', label: t('monitoring.sources.columns.lastReceived'), width: '140px', sortable: true,
      render: (v) => v ? <span title={formatDateTime(String(v))} style={{ color: colors.slate }}>{timeAgo(String(v))}</span> : <span style={{ color: colors.slateLight }}>{t('monitoring.sources.never')}</span>,
    },
    { key: 'receiveCount', label: t('monitoring.sources.columns.received'), width: '90px', sortable: true, render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(v)}</span> },
    {
      key: 'errorCount', label: t('monitoring.sources.columns.errors'), width: '260px', sortable: true,
      render: (_v, row) => row.errorCount === 0 && !row.lastError
        ? <span style={{ color: colors.slateLight }}>{t('monitoring.sources.noErrors')}</span>
        : (
          <div style={{ color: '#b91c1c' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
              <AlertTriangle size={13} aria-hidden="true" />{t('monitoring.sources.errorCount', { count: row.errorCount })}
            </div>
            {row.lastError && (
              <div style={{ fontSize: 'var(--font-size-table)', marginTop: 2, wordBreak: 'break-word' }} title={row.lastErrorAt ? formatDateTime(row.lastErrorAt) : undefined}>
                {t('monitoring.sources.lastError', { error: row.lastError })}
              </div>
            )}
          </div>
        ),
    },
    {
      key: 'id', label: t('monitoring.sources.columns.actions'), width: '180px',
      render: (_v, row) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <Button variant="icon" size="xs" title={t('monitoring.sources.edit')} aria-label={t('monitoring.sources.editAria', { name: row.name })} onClick={() => navigate(`/monitoring/sources/${row.id}`)}><Pencil size={13} aria-hidden="true" /></Button>
          <Button variant="icon" size="xs" title={t('monitoring.sources.sendSample')} aria-label={t('monitoring.sources.sendSampleAria', { name: row.name })} onClick={() => void handleSample(row)}><Send size={13} aria-hidden="true" /></Button>
          <Button variant="icon" size="xs" title={t('monitoring.sources.regenToken')} aria-label={t('monitoring.sources.regenTokenAria', { name: row.name })} onClick={() => void handleRegen(row)}><KeyRound size={13} aria-hidden="true" /></Button>
          <Button variant="icon" size="xs" title={t('monitoring.sources.delete')} aria-label={t('monitoring.sources.deleteAria', { name: row.name })} onClick={() => void handleDelete(row)} style={{ color: colors.danger }}><Trash2 size={13} aria-hidden="true" /></Button>
        </div>
      ),
    },
  ]

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Radar size={22} color="var(--color-icon-accent)" />}
        title={t('monitoring.sources.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading && !data ? '—' : `${t('monitoring.sources.count', { count: sources.length })} · ${t('monitoring.sources.subtitle')}`}
          </p>
        }
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void refetch()}>{t('monitoring.sources.refresh')}</Button>
            <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => navigate('/monitoring/sources/new')}>{t('monitoring.sources.add')}</Button>
          </div>
        }
      />

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <SortableFilterTable<MonitoringSource>
          columns={columns}
          data={sources}
          loading={loading && !data}
          label={t('monitoring.sources.title')}
          emptyComponent={
            <EmptyState
              icon={<Radar size={32} />}
              title={t('monitoring.sources.empty.title')}
              description={t('monitoring.sources.empty.description')}
              action={<Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => navigate('/monitoring/sources/new')}>{t('monitoring.sources.add')}</Button>}
            />
          }
        />
      )}

      {newToken && (
        <Modal open onClose={() => setNewToken(null)} title={`${t('monitoring.sources.newTokenTitle')} — ${newToken.name}`} width={560} closeOnOverlay={false}
          footer={<Button onClick={() => setNewToken(null)}>{t('common.close')}</Button>}>
          <SecretBox label={t('monitoring.wizard.token')} value={newToken.token} copyLabel={t('monitoring.wizard.copyToken')} hint={t('monitoring.sources.newTokenBody')} />
        </Modal>
      )}
    </PageContainer>
  )
}
