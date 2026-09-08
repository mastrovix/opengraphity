import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, ShieldCheck, Radar, RefreshCw } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import {
  GET_ANOMALIES, GET_ANOMALY_STATS, GET_ANOMALY_SCAN_STATUS,
  RESOLVE_ANOMALY, RUN_ANOMALY_SCANNER,
} from '@/graphql/queries'
import { colors, lookupOrError } from '@/lib/tokens'
import { formatDateTime } from '@/lib/datetime'
import { ciTypeLabelKey } from '@/lib/ciEnums'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { DetailPanel } from './AnomalyDetail'
import type { Anomaly, AnomalyStats, AnomalyScanStatus } from '@/types/anomaly'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10

// Lo scan è un job BullMQ: dopo runAnomalyScanner si interroga anomalyScanStatus
// finché totalScans supera il valore pre-scan (= scan completato), invece di
// un setTimeout cieco a 2 s. Oltre il timeout si segnala, non si finge.
const SCAN_POLL_MS    = 2_000
const SCAN_TIMEOUT_MS = 120_000

/** Etichetta del tipo CI dell'entità: chiave i18n fissa (lib/ciEnums) o il nome grezzo. */
export function anomalyEntityTypeLabel(t: (k: string) => string, a: Pick<Anomaly, 'entitySubtype' | 'entityType'>): string {
  const key = ciTypeLabelKey(a.entitySubtype)
  return key ? t(key) : (a.entitySubtype ?? a.entityType)
}

export const RULE_LABEL_KEYS: Record<string, string> = {
  orphan_ci:             'anomaly.rules.orphan_ci',
  spof:                  'anomaly.rules.spof',
  dependency_cycle:      'anomaly.rules.dependency_cycle',
  missing_owner:         'anomaly.rules.missing_owner',
  unauthorized_relation: 'anomaly.rules.unauthorized_relation',
  isolated_cluster:      'anomaly.rules.isolated_cluster',
  risk_concentration:    'anomaly.rules.risk_concentration',
}

export const RULE_SUGGESTION_KEYS: Record<string, string> = {
  orphan_ci:             'anomaly.suggestions.orphan_ci',
  spof:                  'anomaly.suggestions.spof',
  dependency_cycle:      'anomaly.suggestions.dependency_cycle',
  missing_owner:         'anomaly.suggestions.missing_owner',
  unauthorized_relation: 'anomaly.suggestions.unauthorized_relation',
  isolated_cluster:      'anomaly.suggestions.isolated_cluster',
  risk_concentration:    'anomaly.suggestions.risk_concentration',
}

// ── Status badge ──────────────────────────────────────────────────────────────

const ANOMALY_STATUS_STYLE: Record<string, { color: string; weight: number; labelKey: string }> = {
  open:           { color: colors.danger,     weight: 600, labelKey: 'pages.anomalies.statusOpen' },
  resolved:       { color: colors.success,    weight: 500, labelKey: 'pages.anomalies.statusResolved' },
  false_positive: { color: colors.slateLight, weight: 400, labelKey: 'pages.anomalies.statusFalsePositive' },
  accepted_risk:  { color: colors.slateLight, weight: 400, labelKey: 'pages.anomalies.statusAcceptedRisk' },
}

export function AnomalyStatusBadge({ value }: { value: string }) {
  const { t } = useTranslation()
  // Stato fuori vocabolario: rosso e loggato, non un grigio "plausibile".
  const s = lookupOrError(ANOMALY_STATUS_STYLE, value, 'ANOMALY_STATUS_STYLE', { color: colors.danger, weight: 700, labelKey: '' })
  return (
    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: s.weight, color: s.color }}>
      {s.labelKey ? t(s.labelKey) : `?${value}`}
    </span>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      padding: '14px 18px',
      minWidth: 110,
      flex: 1,
    }}>
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 700, color: accent ?? colors.slateDark }}>
        {value}
      </div>
    </div>
  )
}

// ── Smart empty state ─────────────────────────────────────────────────────────

function AnomalyEmptyState({ scanStatus }: { scanStatus: AnomalyScanStatus | null | undefined }) {
  const { t } = useTranslation()
  const neverRun = !scanStatus?.lastScanAt

  if (neverRun) {
    return (
      <div style={{ textAlign: 'center', padding: '56px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <Radar size={44} color={colors.slateLight} />
        </div>
        <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slate, marginBottom: 6 }}>
          {t('pages.anomalies.noScanYet')}
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, maxWidth: 340, margin: '0 auto' }}>
          {t('pages.anomalies.noScanYetDesc')}
        </div>
      </div>
    )
  }

  const lastScan = formatDateTime(scanStatus.lastScanAt)
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <ShieldCheck size={44} color={colors.success} />
      </div>
      <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slate, marginBottom: 6 }}>
        {t('pages.anomalies.noAnomalies')}
      </div>
      <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, maxWidth: 360, margin: '0 auto' }}>
        {t('pages.anomalies.noAnomaliesDesc', { date: lastScan })}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AnomalyPage() {
  const { t } = useTranslation()
  const [selected, setSelected]         = useState<Anomaly | null>(null)

  const columns: ColumnDef<Anomaly>[] = [
    {
      key:      'title',
      label:    t('pages.anomalies.title_col'),
      sortable: true,
      render: (v, row) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{String(v)}</div>
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            {row.description.length > 64
              ? row.description.slice(0, 61) + '…'
              : row.description}
          </div>
        </div>
      ),
    },
    {
      key:      'severity',
      label:    t('pages.anomalies.severity'),
      width:    '120px',
      sortable: true,
      render:   (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:      'status',
      label:    t('pages.anomalies.status'),
      width:    '130px',
      sortable: true,
      render:   (v) => <AnomalyStatusBadge value={String(v)} />,
    },
    {
      key:      'entityName',
      label:    t('pages.anomalies.entity'),
      sortable: true,
      render: (v, row) => (
        <div>
          <div style={{ color: 'var(--color-slate-dark)' }}>{String(v)}</div>
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            {anomalyEntityTypeLabel(t, row)}
          </div>
        </div>
      ),
    },
    {
      key:      'detectedAt',
      label:    t('pages.anomalies.detectedAtCol'),
      width:    '160px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
          {formatDateTime(String(v))}
        </span>
      ),
    },
  ]

  const ANOMALY_FILTER_FIELDS: FieldConfig[] = [
    { key: 'title',      label: t('common.title'),                    type: 'text' },
    { key: 'severity',   label: t('pages.anomalies.severity'),        type: 'enum', options: [
      { value: 'critical', label: 'Critical' },
      { value: 'high',     label: 'High'     },
      { value: 'medium',   label: 'Medium'   },
      { value: 'low',      label: 'Low'      },
    ]},
    { key: 'status',     label: t('pages.anomalies.status'),          type: 'enum', options: [
      { value: 'open',           label: t('pages.anomalies.statusOpen')          },
      { value: 'resolved',       label: t('pages.anomalies.statusResolved')      },
      { value: 'false_positive', label: t('pages.anomalies.statusFalsePositive') },
      { value: 'accepted_risk',  label: t('pages.anomalies.statusAcceptedRisk')  },
    ]},
    { key: 'ruleKey',    label: t('pages.anomalies.type'),            type: 'enum', options: [
      { value: 'orphan_ci',             label: t('anomaly.rules.orphan_ci')             },
      { value: 'spof',                  label: t('anomaly.rules.spof')                  },
      { value: 'dependency_cycle',      label: t('anomaly.rules.dependency_cycle')      },
      { value: 'missing_owner',         label: t('anomaly.rules.missing_owner')         },
      { value: 'unauthorized_relation', label: t('anomaly.rules.unauthorized_relation') },
      { value: 'isolated_cluster',      label: t('anomaly.rules.isolated_cluster')      },
      { value: 'risk_concentration',    label: t('anomaly.rules.risk_concentration')    },
    ]},
    { key: 'detectedAt', label: t('pages.anomalies.detectedAtCol'),   type: 'date' },
  ]
  const [mutLoading, setMutLoading]     = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [page, setPage]                 = useState(0)
  const [filterGroup, setFilterGroup]   = useState<FilterGroup | null>(null)
  const [sortField, setSortField]       = useState<string | null>(null)
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data: statsData, refetch: refetchStats } = useQuery<{ anomalyStats: AnomalyStats }>(
    GET_ANOMALY_STATS,
  )
  const { data: scanData, refetch: refetchScan } = useQuery<{ anomalyScanStatus: AnomalyScanStatus }>(
    GET_ANOMALY_SCAN_STATUS,
  )
  const { data, loading, refetch } = useQuery<{ anomalies: { items: Anomaly[]; total: number } }>(
    GET_ANOMALIES,
    {
      variables: {
        limit:         PAGE_SIZE,
        offset:        page * PAGE_SIZE,
        filters:       filterGroup ? JSON.stringify(filterGroup) : null,
        sortField,
        sortDirection: sortDir,
      },
      fetchPolicy: 'cache-and-network',
    },
  )

  const [resolveAnomaly] = useMutation(RESOLVE_ANOMALY)
  const [runScanner, { loading: enqueueLoading }] = useMutation<{ runAnomalyScanner: boolean }>(RUN_ANOMALY_SCANNER)

  // Scan in attesa di completamento: totalScans letto PRIMA dell'avvio.
  const [awaitingScan, setAwaitingScan] = useState<{ baseline: number; startedAt: number } | null>(null)
  const scannerLoading = enqueueLoading || awaitingScan !== null

  useEffect(() => {
    if (!awaitingScan) return
    let cancelled = false
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await refetchScan()
          if (cancelled) return
          const totalScans = res.data?.anomalyScanStatus.totalScans ?? 0
          if (totalScans > awaitingScan.baseline) {
            setAwaitingScan(null)
            setPage(0)
            void refetch()
            void refetchStats()
            toast.success(t('pages.anomalies.runScanner') + ': completato')
          } else if (Date.now() - awaitingScan.startedAt > SCAN_TIMEOUT_MS) {
            setAwaitingScan(null)
            toast.error(`Scan non completato entro ${SCAN_TIMEOUT_MS / 1000}s: verifica il worker delle anomalie (i risultati compariranno al prossimo refresh).`)
          }
        } catch (err) {
          if (cancelled) return
          setAwaitingScan(null)
          toast.error(err instanceof Error ? err.message : String(err))
        }
      })()
    }, SCAN_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [awaitingScan, refetch, refetchStats, refetchScan, t])

  const stats      = statsData?.anomalyStats
  const scanStatus = scanData?.anomalyScanStatus
  const anomalies  = data?.anomalies?.items ?? []
  const total      = data?.anomalies?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)


  async function handleResolve(id: string, resolutionStatus: string, note: string) {
    setMutLoading(true)
    setResolveError(null)
    try {
      await resolveAnomaly({ variables: { id, resolutionStatus, note } })
      void refetch()
      void refetchStats()
      setSelected(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('pages.anomalies.errResolving')
      setResolveError(msg)
    } finally {
      setMutLoading(false)
    }
  }

  async function handleRunScanner() {
    try {
      const before = await refetchScan()
      const baseline = before.data?.anomalyScanStatus.totalScans ?? 0
      const res = await runScanner()
      // L'API risponde false quando non riesce ad accodare il job (Redis giù):
      // non è un successo silenzioso.
      if (!res.data?.runAnomalyScanner) {
        toast.error('Impossibile avviare lo scan: coda dei job non disponibile.')
        return
      }
      setAwaitingScan({ baseline, startedAt: Date.now() })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <PageTitle icon={<ShieldAlert size={22} color="var(--color-icon-accent)" />}>
            {t('pages.anomalies.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.anomalies.count', { count: total })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRunScanner()}
          disabled={scannerLoading}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 6,
            border: `1px solid ${colors.border}`, background: 'var(--surface)',
            fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: scannerLoading ? 'not-allowed' : 'pointer',
            color: colors.slate,
          }}
        >
          <RefreshCw size={14} style={{ animation: scannerLoading ? 'spin 1s linear infinite' : undefined }} />
          {t('pages.anomalies.runScanner')}
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatCard label={t('pages.anomalies.statsOpen')} value={stats.open}     accent={colors.danger}                     />
            <StatCard label="Critical"                       value={stats.critical} accent={colors.severity.critical.text}     />
            <StatCard label="High"                           value={stats.high}     accent={colors.severity.high.text}         />
            <StatCard label="Medium"                         value={stats.medium}   accent={colors.severity.medium.text}       />
            <StatCard label="Low"                            value={stats.low}      accent={colors.severity.low.text}          />
          </div>
          {(stats.falsePositive > 0 || stats.acceptedRisk > 0) && (
            <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, paddingLeft: 2 }}>
              {[
                stats.falsePositive > 0 ? t('pages.anomalies.falsePositives', { count: stats.falsePositive }) : null,
                stats.acceptedRisk  > 0 ? t('pages.anomalies.acceptedRisks',  { count: stats.acceptedRisk })  : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <FilterBuilder
        fields={ANOMALY_FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      {/* Table */}
      <div className="card-border" style={{ overflow: 'hidden' }}>
        {!loading && anomalies.length === 0 ? (
          <AnomalyEmptyState scanStatus={scanStatus} />
        ) : (
          <SortableFilterTable<Anomaly>
            data={anomalies}
            columns={columns}
            loading={loading}
            onRowClick={(row) => setSelected(row)}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
          />
        )}
      </div>

      {/* Pagination */}
      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />

      {/* Detail panel */}
      {selected && (
        <DetailPanel
          key={selected.id}
          anomaly={selected}
          onClose={() => { setSelected(null); setResolveError(null) }}
          onResolve={(id, resolutionStatus, note) => void handleResolve(id, resolutionStatus, note)}
          loading={mutLoading}
          resolveError={resolveError}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </PageContainer>
  )
}
