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
 * grafo), il pulsante di stato che segue lo stato vero («Attiva» per una
 * bozza, «Metti in pausa» per una attiva, «Riattiva» per una in pausa, con
 * `expectedVersion` = la versione letta), «Elimina» (con conferma). Le
 * mutation restituiscono la mappa completa: la cache aggiorna la pagina.
 *
 * Freschezza (revisione 2 · C-8): in polling (15 s, in pausa a scheda
 * nascosta) va una SONDA di tre marcatori — versione, ultima valutazione,
 * ultima sincronizzazione — letta `no-cache`; il documento completo (nodi,
 * archi, cronologia) si rilegge solo quando la sonda è più avanti. Prima mezzo
 * megabyte di mappa ripartiva ogni quindici secondi per ogni scheda aperta.
 *
 * Ondata 2: regole e componenti si modificano qui dentro (solo admin); per
 * gli altri ruoli i riquadri restano quelli di sola lettura, senza controlli.
 * Ondata 3: il riquadro «Incident aperto» (ServiceOpenIncidentCard) con
 * l'incident non chiuso che il monitoraggio ha aperto per il servizio.
 * Ondata 5: la mappa è viva per default — badge «viva»/«congelata» accanto al
 * nome, «ultima sincronizzazione» accanto a «ultima valutazione», interruttore
 * per congelarla (ServiceAutoSyncToggle) e pulsante che cambia con la modalità
 * («Sincronizza ora» se viva, «Aggiorna mappa» se congelata; il dialogo del
 * diff resta raggiungibile come «Rivedi componenti»).
 * Revisione 2: l'esito della sincronizzazione arriva dal motore
 * (`ServiceMapSyncResult`: rifiutata col motivo, già allineata, «+N −M ~K»),
 * l'avviso «da rivedere» dice il motivo vero (`staleReason`) e la testata
 * mostra la salute che il servizio avrebbe senza la finestra di change
 * (`healthIfActive`).
 * Revisione 2, ondata 3 (D6.2/D6.4): sotto la salute compare la nota della
 * valutazione (`healthNote`) quando c'è — sorgente in tempesta con
 * valutazione sospesa, oppure componente coperto da una change a monte.
 * Revisione 2, ondata 5 (C-11/C-12): i metadati stanno UNA volta sola in
 * testata (versione compresa) e la scheda tiene la sola configurazione;
 * «Sincronizza ora» è disabilitato con la spiegazione quando la mappa è ferma
 * (il motore la rifiuterebbe), mentre «Rivaluta ora» resta offerto perché
 * l'API lo accetta anche da ferma; il pannello del nodo dice «da dove si
 * arriva» (`via`) come link che seleziona il predecessore.
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Boxes, RotateCcw, Pause, Play, Trash2, AlertTriangle, Focus, Info, Star, Loader2, ArrowRight, GitCompareArrows, RefreshCw } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { Modal } from '@/components/Modal'
import { DetailField } from '@/components/ui/DetailField'
import { Pill } from '@/components/ui/Pill'
import { useMe } from '@/hooks/useMe'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { GET_SERVICE_MAP, GET_SERVICE_MAP_STATUS } from '@/graphql/queries'
import { REEVALUATE_SERVICE_MAP, SET_SERVICE_MAP_STATUS, DELETE_SERVICE_MAP, SYNC_SERVICE_MAP } from '@/graphql/mutations'
import { formatDateTime, formatDuration, timeAgo } from '@/lib/datetime'
import { pausedWhenHidden } from '@/lib/polling'
import { ciPath } from '@/lib/ciPath'
import { ciTypeLabelKey, enumLabel } from '@/lib/ciEnums'
import { colors, lookupOrError, palette } from '@/lib/tokens'
import { AMBER_BANNER, TINT_NEUTRAL, TINT_WARNING } from '@/lib/eventPalette'
import { ServiceMapCanvas } from './ServiceMapCanvas'
import { ServiceHistorySection } from './ServiceHistorySection'
import { ServiceComponentsTable } from './ServiceComponentsTable'
import { ServiceRulesCard } from './ServiceRulesCard'
import { ServiceOpenIncidentCard } from './ServiceOpenIncidentCard'
import { UpdateServiceMapDialog } from './UpdateServiceMapDialog'
import { ServiceAutoSyncToggle } from './ServiceAutoSyncToggle'
import {
  ServiceHealthBadge, ServiceStatusPill, ServiceSyncModePill, NodeHealthBadge, ImpactScore,
  causeSequenceLabel, excludedReasonLabel, explanationSentence, healthIfActiveNote, propagationLabel, roleLabel,
  serviceStatusLabel, serviceHealthLabel, staleMessage,
} from './servicesShared'
import type { ServiceMapDetail, ServiceMapNode, ImpactCause, ServiceMapStatus, ServiceMapSyncResult } from '@/types/services'

const POLL_MS = 15_000
const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

/** I tre marcatori della sonda del polling (C-8). */
interface ServiceMapProbe { id: string; version: number; evaluatedAt: string | null; syncedAt: string | null }

/**
 * La sonda è «più avanti» del documento che la pagina ha in mano? I tre
 * marcatori crescono sempre (la versione si incrementa, gli istanti vanno
 * avanti): il confronto è in UNA direzione sola, così una mutation appena
 * salvata — che porta il documento avanti PRIMA della sonda — non fa ripartire
 * una rilettura inutile.
 */
function probeIsAhead(probe: ServiceMapProbe, loaded: Pick<ServiceMapDetail, 'version' | 'evaluatedAt' | 'syncedAt'>): boolean {
  return probe.version > loaded.version
    || (probe.evaluatedAt ?? '') > (loaded.evaluatedAt ?? '')
    || (probe.syncedAt ?? '') > (loaded.syncedAt ?? '')
}

/** Cosa fa il pulsante di stato: dove porta la mappa e con quale etichetta. */
interface StatusAction { next: ServiceMapStatus; label: 'activate' | 'pause' | 'resume' }

/**
 * Una bozza si ATTIVA (non «si riattiva»): senza questa distinzione l'unico
 * modo di attivarla era metterla in pausa e riattivarla (C-4).
 */
const STATUS_ACTION: Record<ServiceMapStatus, StatusAction> = {
  draft:  { next: 'active', label: 'activate' },
  active: { next: 'paused', label: 'pause' },
  paused: { next: 'active', label: 'resume' },
}

export function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isAdmin } = useMe()
  const confirm = useConfirm()
  const { ciTypes } = useMetamodel()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** «Isola»: la mappa mostra solo la catena di questo componente. Vive qui perché il pulsante sta nel pannello del componente. */
  const [isolatedId, setIsolatedId] = useState<string | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)

  /**
   * C-8: in polling va SOLO la sonda (tre marcatori, `no-cache`), non l'intero
   * dettaglio. Prima nodi, archi e 50 voci di cronologia con le cause
   * ripartivano ogni quindici secondi per ogni scheda aperta.
   */
  const { data: probeData } = useQuery<{ serviceMap: ServiceMapProbe | null }>(GET_SERVICE_MAP_STATUS, {
    variables: { id }, fetchPolicy: 'no-cache', ...pausedWhenHidden(POLL_MS),
  })
  const { data, previousData, loading, error, refetch } = useQuery<{ serviceMap: ServiceMapDetail | null }>(GET_SERVICE_MAP, {
    variables: { id }, fetchPolicy: 'cache-first',
  })
  /**
   * Rilettura del documento pesante SOLO quando la sonda è più avanti: una
   * valutazione nuova (cause e salute dei componenti diverse), una
   * sincronizzazione (nodi e archi diversi) o una configurazione salvata da un
   * altro amministratore. Le mutation di questa pagina restituiscono già il
   * documento completo: non fanno scattare nulla.
   */
  const loaded = (data ?? previousData)?.serviceMap ?? null
  const probe  = probeData?.serviceMap ?? null
  const behind = probe !== null && loaded !== null && probeIsAhead(probe, loaded)
  useEffect(() => { if (behind) void refetch() }, [behind, refetch])

  const [reevaluate, { loading: reevaluating }] = useMutation<{ reevaluateServiceMap: ServiceMapDetail }>(REEVALUATE_SERVICE_MAP)
  const [setStatus, { loading: settingStatus }] = useMutation<{ setServiceMapStatus: ServiceMapDetail }>(SET_SERVICE_MAP_STATUS)
  const [deleteMap, { loading: deleting }] = useMutation<{ deleteServiceMap: boolean }>(DELETE_SERVICE_MAP)
  const [syncMap, { loading: syncing }] = useMutation<{ syncServiceMap: ServiceMapSyncResult }>(SYNC_SERVICE_MAP)

  if (loading && !data && !previousData) return <PageLoader />
  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  const map = loaded
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
  const busy = reevaluating || settingStatus || deleting || syncing
  /**
   * Mappa ferma: il motore rifiuta la sincronizzazione manuale (`sync.ts`:
   * «is paused: reactivate it before synchronizing»). «Rivaluta ora» invece
   * l'API la accetta anche da ferma (`evaluateServiceMap` non guarda lo stato):
   * resta offerto.
   */
  const paused = map.status === 'paused'
  const ifActive = healthIfActiveNote(t, map)
  const statusAction = lookupOrError(STATUS_ACTION as Record<string, StatusAction>, map.status, 'SERVICE_STATUS_ACTION', STATUS_ACTION.active)

  async function onReevaluate() {
    try {
      const res = await reevaluate({ variables: { id } })
      const next = res.data?.reevaluateServiceMap
      if (!next) throw new Error(t('monitoring.services.detail.noResult', { operation: 'reevaluateServiceMap' }))
      toast.success(t('toast.services.reevaluated', { health: serviceHealthLabel(t, next.health) }))
    } catch (e) { toast.error(t('toast.services.actionFailed', { error: errorMessage(e) })) }
  }

  /**
   * «Sincronizza ora» (mappa viva): l'esito arriva dal motore
   * (`ServiceMapSyncResult`), non si deduce dal diff dei componenti.
   * `skipped` = la sincronizzazione è stata RIFIUTATA (tetto dei componenti):
   * avviso col motivo, mai un successo dove il motore non ha scritto nulla.
   * Tutti i conteggi a zero → «già allineata»; altrimenti «+N −M ~K».
   */
  async function onSyncNow() {
    if (!map) return
    try {
      const res = await syncMap({ variables: { id } })
      const out = res.data?.syncServiceMap
      if (!out) throw new Error(t('monitoring.services.detail.noResult', { operation: 'syncServiceMap' }))
      if (out.skipped) {
        toast.warning(t('toast.services.syncSkipped', { reason: out.reason ?? t('toast.services.syncSkippedNoReason') }))
        return
      }
      toast.success(out.added === 0 && out.removed === 0 && out.moved === 0
        ? t('toast.services.syncAligned')
        : t('toast.services.synced', { added: out.added, removed: out.removed, moved: out.moved }))
    } catch (e) { toast.error(t('toast.services.actionFailed', { error: errorMessage(e) })) }
  }

  /** Bozza → attiva, attiva → in pausa, in pausa → riattivata: un pulsante solo, con l'etichetta dello stato vero. */
  async function onChangeStatus(status: ServiceMapStatus) {
    if (!map) return
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
          <ServiceSyncModePill autoSync={map.autoSync} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
          <ImpactScore score={map.impactScore} health={map.health} width={120} />
          {/* R1: la finestra di change non deve nascondere quanto starebbe male il servizio senza di essa. */}
          {ifActive && <span data-testid="health-if-active" style={{ color: palette.purple.text, fontWeight: 500 }}>{ifActive}</span>}
          {since && <span title={t('monitoring.services.sinceHint', { date: formatDateTime(map.healthSince) })}>{t('monitoring.services.since', { duration: since })}</span>}
          <span data-testid="evaluated-at" title={map.evaluatedAt ? formatDateTime(map.evaluatedAt) : undefined}>
            {map.evaluatedAt ? t('monitoring.services.detail.evaluated', { ago: timeAgo(map.evaluatedAt) }) : t('monitoring.services.detail.neverEvaluated')}
          </span>
          <span data-testid="synced-at" title={map.syncedAt ? t('monitoring.services.syncMode.syncedHint', { date: formatDateTime(map.syncedAt) }) : undefined}>
            {map.syncedAt ? t('monitoring.services.syncMode.synced', { ago: timeAgo(map.syncedAt) }) : t('monitoring.services.syncMode.neverSynced')}
          </span>
          {/* C-12: la versione sta qui, dove si leggono gli altri metadati; la scheda tiene solo la configurazione. */}
          <span data-testid="map-version" title={map.updatedAt ? t('monitoring.services.detail.updatedHint', { date: formatDateTime(map.updatedAt) }) : undefined}>
            {t('monitoring.services.detail.versionShort', { version: map.version })}
          </span>
        </div>
        {/* R2 (D6.2/D6.4): perché la salute è questa quando le cause non bastano — sorgente in tempesta o change su un CI a monte. */}
        {map.healthNote && (
          <p data-testid="health-note" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 0', padding: '8px 12px', borderRadius: 8, background: palette.neutral.surface1, border: `1px solid ${colors.border}`, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
            <Info size={14} aria-hidden="true" style={{ flexShrink: 0, color: colors.slateLight }} />
            <span>{map.healthNote}</span>
          </p>
        )}
        {/* Da rivedere: il motivo lo dice il motore (`staleReason`); col tetto superato sincronizzare fallirebbe di nuovo, quindi si manda a «Rivedi componenti». */}
        {map.stale && (
          <div role="alert" data-testid="stale-banner" data-reason={map.staleReason ?? 'none'} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '10px 14px', borderRadius: 8, background: AMBER_BANNER.bg, border: `1px solid ${AMBER_BANNER.border}`, color: AMBER_BANNER.text, fontSize: 'var(--font-size-body)' }}>
            <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span>{staleMessage(t, map.staleReason)}</span>
            {isAdmin && map.staleReason === 'over_limit' && (
              <Button variant="secondary" size="xs" disabled={busy} icon={<GitCompareArrows size={13} aria-hidden="true" />} onClick={() => setUpdateOpen(true)}>
                {t('monitoring.services.detail.actions.reviewComponents')}
              </Button>
            )}
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
            {/* Mappa viva: si sincronizza a richiesta e il diff serve solo a rivedere ed escludere; congelata: il diff è l'unico modo di far entrare i componenti nuovi. */}
            {/* C-11: su una mappa in pausa il motore rifiuta la sincronizzazione manuale: il pulsante è disabilitato e dice perché, invece di fallire ogni volta. */}
            {map.autoSync && (
              <Button
                variant="secondary" size="sm"
                disabled={busy || paused}
                title={paused ? t('monitoring.services.detail.actions.syncPaused') : undefined}
                icon={syncing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                onClick={() => void onSyncNow()}
              >
                {t('monitoring.services.detail.actions.syncNow')}
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={busy} icon={<GitCompareArrows size={14} aria-hidden="true" />} onClick={() => setUpdateOpen(true)}>
              {map.autoSync ? t('monitoring.services.detail.actions.reviewComponents') : t('monitoring.services.detail.actions.updateMap')}
            </Button>
            {/* Tre stati, tre etichette: una bozza si attiva, non «si riattiva» dopo essere stata messa in pausa. */}
            <Button variant="secondary" size="sm" disabled={busy} icon={statusAction.next === 'active' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />} onClick={() => void onChangeStatus(statusAction.next)}>
              {t(`monitoring.services.detail.actions.${statusAction.label}`)}
            </Button>
            <Button variant="danger" size="sm" disabled={busy} icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => void onDelete()}>
              {t('monitoring.services.detail.actions.delete')}
            </Button>
          </div>
        )}
      </div>

      {/*
        Una sola colonna, a tutta larghezza: la mappa a livelli e la tabella dei
        componenti sono larghe per natura e in due colonne finivano in un terzo
        di schermo. L'ordine segue l'urgenza — cosa è rotto, perché, dove — e
        solo i primi tre riquadri si aprono da soli: il resto è configurazione e
        storia, che si guardano quando servono.
      */}
      <div>
        {/* Incident aperto dal monitoraggio per questo servizio (ondata 3): la prima cosa da sapere. */}
        <ServiceOpenIncidentCard incident={map.openIncident} openIncidentFrom={map.rules.openIncidentFrom} />

        <SectionCard title={t('monitoring.services.detail.why')} count={map.explanation.length} defaultOpen>
          {map.explanation.length === 0
            ? <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('monitoring.services.detail.whyEmpty')}</p>
            : (
              <ol data-testid="why-list" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {map.explanation.map((c) => <CauseRow key={c.ci.id} cause={c} serviceName={map.service.name} typeLabel={ciTypeLabel(c.ci.type)} onSelect={setSelectedId} />)}
              </ol>
            )}
        </SectionCard>

        <SectionCard title={t('monitoring.services.detail.map')} count={map.nodeCount} defaultOpen>
          <ServiceMapCanvas map={map} selectedId={selectedId} onSelect={setSelectedId} isolatedId={isolatedId} onIsolate={setIsolatedId} />
        </SectionCard>

        <SectionCard title={t('monitoring.services.detail.components')} count={map.nodeCount}>
          <ServiceComponentsTable map={map} canEdit={isAdmin} ciTypeLabel={ciTypeLabel} onReload={() => void refetch()} />
        </SectionCard>

        {/* C-12: la scheda tiene la sola CONFIGURAZIONE; stato, valutazione, sincronizzazione e versione stanno una volta sola, in testata. */}
        <SectionCard title={t('monitoring.services.detail.service')}>
          <DetailField label={t('monitoring.services.detail.fields.service')} value={map.service.name} />
          <DetailField label={t('monitoring.services.detail.fields.criticality')} value={map.service.criticality ? enumLabel(map.service.criticality) : null} />
          <DetailField label={t('monitoring.services.detail.fields.owner')} value={map.service.ownerGroup?.name ?? null} />
          <DetailField label={t('monitoring.services.detail.fields.maxDepth')} value={String(map.maxDepth)} />
          <DetailField label={t('monitoring.services.detail.fields.relationshipTypes')} value={map.relationshipTypes.length > 0 ? map.relationshipTypes.join(', ') : null} />
          <DetailField label={t('monitoring.services.detail.fields.builtFrom')} value={builtFromLabel(map.builtFrom, t)} />
          <DetailField label={t('monitoring.services.detail.fields.excluded')} value={t('monitoring.services.detail.fields.excludedCount', { count: map.excluded.length })} />
          <DetailField label={t('monitoring.services.detail.fields.updatedAt')} value={map.updatedAt ? `${formatDateTime(map.updatedAt)} · ${timeAgo(map.updatedAt)}` : null} />
          {isAdmin && <ServiceAutoSyncToggle map={map} onReload={() => void refetch()} />}
        </SectionCard>

        <ServiceRulesCard map={map} canEdit={isAdmin} onReload={() => void refetch()} />

        <ServiceHistorySection mapId={map.id} entries={map.history} total={map.historyCount} />

        {/* Il componente scelto: finestra modale sopra la pagina, non una scheda di fianco. */}
        {selected && (
          <NodePanel
            node={selected}
            typeLabel={ciTypeLabel(selected.ci.type)}
            isolated={isolatedId === selected.ci.id}
            /* Isolando si chiude la finestra: la catena va guardata sulla mappa, che la finestra copre. */
            onIsolate={() => { setIsolatedId((cur) => (cur === selected.ci.id ? null : selected.ci.id)); setSelectedId(null) }}
            /* C-12: «da dove si arriva» — il predecessore, che la sincronizzazione aggiorna; cliccarlo lo seleziona sulla mappa. */
            via={selected.via === null ? null : (nodeById.get(selected.via)?.ci ?? null)}
            viaMissing={selected.via !== null && !nodeById.has(selected.via)}
            onSelect={setSelectedId}
            onClose={() => setSelectedId(null)}
          />
        )}
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

interface NodePanelProps {
  node:       ServiceMapNode
  typeLabel:  string
  /** Il predecessore (`via`) quando è un componente della mappa. */
  via:        { id: string; name: string } | null
  /** `via` valorizzato ma non incluso nella mappa: si dice, non si tace. */
  viaMissing: boolean
  /** La mappa sta già mostrando solo la catena di QUESTO componente. */
  isolated:   boolean
  onIsolate:  () => void
  onSelect:   (id: string) => void
  onClose:    () => void
}

/** Pannello laterale del componente selezionato sulla mappa. */
/**
 * Il componente scelto si apre in una finestra modale, non in una scheda della
 * colonna: la mappa è larga e il dettaglio va letto senza cercarlo di fianco.
 * La finestra porta con sé quel che serve (Esc, trappola del fuoco, ritorno del
 * fuoco al nodo da cui si è partiti).
 */
function NodePanel({ node, typeLabel, via, viaMissing, isolated, onIsolate, onSelect, onClose }: NodePanelProps) {
  const { t } = useTranslation()
  const yesNo = (v: boolean) => (v ? t('common.yes') : t('common.no'))
  const consoleLink = `/events?ciId=${encodeURIComponent(node.ci.id)}`
  return (
    <Modal open onClose={onClose} title={t('monitoring.services.detail.node')} width={620}>
      <div data-testid="node-panel" data-ci-id={node.ci.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <DetailField label={t('monitoring.services.detail.nodeFields.name')} value={<Link to={ciPath(node.ci)} style={linkStyle}>{node.ci.name}</Link>} />
        </div>
        <DetailField label={t('monitoring.services.detail.nodeFields.type')} value={typeLabel} />
        <DetailField label={t('monitoring.services.detail.nodeFields.level')} value={String(node.level)} />
        <DetailField
          label={t('monitoring.services.detail.nodeFields.via')}
          value={via
            ? (
              <button type="button" data-testid="node-via" onClick={() => onSelect(via.id)} title={t('monitoring.services.why.select', { name: via.name })} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 500, color: colors.brand, cursor: 'pointer' }}>
                {via.name}
              </button>
            )
            : viaMissing
              ? <span data-testid="node-via" style={{ color: palette.warning.text }}>{t('monitoring.services.detail.nodeFields.viaMissing')}</span>
              : <span data-testid="node-via">{t('monitoring.services.detail.nodeFields.viaService')}</span>}
        />
        <DetailField label={t('monitoring.services.detail.nodeFields.role')} value={roleLabel(t, node.role)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.propagate')} value={propagationLabel(t, node.propagate)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.weight')} value={String(node.weight)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.critical')} value={yesNo(node.critical)} />
        <DetailField label={t('monitoring.services.detail.nodeFields.health')} value={<NodeHealthBadge health={node.health} />} />
        <DetailField label={t('monitoring.services.detail.nodeFields.inMaintenance')} value={yesNo(node.inMaintenance)} />
        {/* R1: se non conta, il motivo — le due manutenzioni (ciclo di vita e finestra di change) non sono la stessa cosa. */}
        <DetailField
          label={t('monitoring.services.detail.nodeFields.contributes')}
          value={node.contributes ? yesNo(true) : `${yesNo(false)} — ${excludedReasonLabel(t, node.excludedReason) ?? t('monitoring.services.excludedReason.unstated')}`}
        />
        <DetailField label={t('monitoring.services.detail.nodeFields.addedBy')} value={addedByLabel(node.addedBy, t)} />
        {/* «Isola»: la mappa mostra solo la catena di questo componente (lui, da dove si arriva, chi dipende da lui). */}
        <div style={{ gridColumn: '1 / -1' }}>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={isolated}
            icon={<Focus size={14} aria-hidden="true" />}
            title={t('monitoring.services.map.isolateHint')}
            onClick={onIsolate}
          >
            {isolated ? t('monitoring.services.map.isolateOff') : t('monitoring.services.map.isolate')}
          </Button>
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
          <Link to={consoleLink} style={{ ...linkStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t('monitoring.services.detail.nodeFields.alarms')} <ArrowRight size={11} aria-hidden="true" />
          </Link>
          <Link to={ciPath(node.ci)} style={{ ...linkStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t('monitoring.services.detail.nodeFields.openCI')} <ArrowRight size={11} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </Modal>
  )
}

function addedByLabel(value: string, t: TFn): string {
  if (value === 'auto')   return t('monitoring.services.detail.nodeFields.addedByAuto')
  if (value === 'manual') return t('monitoring.services.detail.nodeFields.addedByManual')
  return t('monitoring.services.health.outOfVocabulary', { value })
}
