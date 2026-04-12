import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
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
import { colors } from '@/lib/tokens'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { DetailPanel } from './AnomalyDetail'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Anomaly {
  id:               string
  ruleKey:          string
  title:            string
  severity:         string
  status:           string
  entityId:         string
  entityType:       string
  entitySubtype:    string
  entityName:       string
  description:      string
  detectedAt:       string
  resolvedAt:       string | null
  resolutionStatus: string | null
  resolutionNote:   string | null
  resolvedBy:       string | null
}

interface AnomalyStats {
  total:         number
  open:          number
  critical:      number
  high:          number
  medium:        number
  low:           number
  falsePositive: number
  acceptedRisk:  number
}

interface AnomalyScanStatus {
  lastScanAt:  string | null
  totalScans:  number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10

// CI_TYPE_LABEL is used inside components that receive t() — kept as a key lookup
export const CI_TYPE_KEYS: Record<string, string> = {
  application:       'sidebar.application',
  database:          'sidebar.database',
  database_instance: 'sidebar.dbInstance',
  server:            'sidebar.server',
  certificate:       'sidebar.certificate',
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

export function AnomalyStatusBadge({ value }: { value: string }) {
  const { t } = useTranslation()
  const map: Record<string, { color: string; weight?: number }> = {
    open:           { color: colors.danger,     weight: 600 },
    resolved:       { color: colors.success,    weight: 500 },
    false_positive: { color: colors.slateLight, weight: 400 },
    accepted_risk:  { color: colors.slateLight, weight: 400 },
  }
  const labelMap: Record<string, string> = {
    open:           t('pages.anomalies.statusOpen'),
    resolved:       t('pages.anomalies.statusResolved'),
    false_positive: t('pages.anomalies.statusFalsePositive'),
    accepted_risk:  t('pages.anomalies.statusAcceptedRisk'),
  }
  const s = map[value] ?? { color: colors.slate, weight: 400 }
  return (
    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: s.weight, color: s.color }}>
      {labelMap[value] ?? value}
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

  const lastScan = new Date(scanStatus.lastScanAt!).toLocaleString()
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
            {CI_TYPE_KEYS[row.entitySubtype] ? t(CI_TYPE_KEYS[row.entitySubtype]) : (row.entitySubtype ?? row.entityType)}
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
          {new Date(String(v)).toLocaleString()}
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
  const [runScanner, { loading: scannerLoading }] = useMutation(RUN_ANOMALY_SCANNER)

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
    await runScanner()
    setPage(0)
    setTimeout(() => { void refetch(); void refetchStats(); void refetchScan() }, 2000)
  }

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <PageTitle icon={<ShieldAlert size={22} color="#38bdf8" />}>
            {t('pages.anomalies.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
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
