import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, ShieldCheck, Radar, RefreshCw, X, Lightbulb } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import {
  GET_ANOMALIES, GET_ANOMALY_STATS, GET_ANOMALY_SCAN_STATUS,
  RESOLVE_ANOMALY, RUN_ANOMALY_SCANNER,
} from '@/graphql/queries'
import { colors } from '@/lib/tokens'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Anomaly {
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
const CI_TYPE_KEYS: Record<string, string> = {
  application:       'sidebar.application',
  database:          'sidebar.database',
  database_instance: 'sidebar.dbInstance',
  server:            'sidebar.server',
  certificate:       'sidebar.certificate',
}

const RULE_LABEL_KEYS: Record<string, string> = {
  orphan_ci:             'anomaly.rules.orphan_ci',
  spof:                  'anomaly.rules.spof',
  dependency_cycle:      'anomaly.rules.dependency_cycle',
  missing_owner:         'anomaly.rules.missing_owner',
  unauthorized_relation: 'anomaly.rules.unauthorized_relation',
  isolated_cluster:      'anomaly.rules.isolated_cluster',
  risk_concentration:    'anomaly.rules.risk_concentration',
}

const RULE_SUGGESTION_KEYS: Record<string, string> = {
  orphan_ci:             'anomaly.suggestions.orphan_ci',
  spof:                  'anomaly.suggestions.spof',
  dependency_cycle:      'anomaly.suggestions.dependency_cycle',
  missing_owner:         'anomaly.suggestions.missing_owner',
  unauthorized_relation: 'anomaly.suggestions.unauthorized_relation',
  isolated_cluster:      'anomaly.suggestions.isolated_cluster',
  risk_concentration:    'anomaly.suggestions.risk_concentration',
}

// ── Status badge ──────────────────────────────────────────────────────────────

function AnomalyStatusBadge({ value }: { value: string }) {
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
    <span style={{ fontSize: 12, fontWeight: s.weight, color: s.color }}>
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
      <div style={{ fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent ?? colors.slateDark }}>
        {value}
      </div>
    </div>
  )
}

// ── Resolution form ───────────────────────────────────────────────────────────

function ResolutionForm({
  anomaly,
  onConfirm,
  onCancel,
  loading,
  error,
}: {
  anomaly: Anomaly
  onConfirm: (resolutionStatus: string, note: string) => void
  onCancel: () => void
  loading: boolean
  error?: string | null
}) {
  const { t } = useTranslation()
  const [resolutionStatus, setResolutionStatus] = useState('')
  const [note, setNote]                         = useState('')

  const suggestionKey = RULE_SUGGESTION_KEYS[anomaly.ruleKey]
  const suggestion    = suggestionKey ? t(suggestionKey) : null
  const isValid       = resolutionStatus !== '' && note.trim().length >= 10

  const resolutionOptions = [
    { value: 'resolved',       label: t('pages.anomalies.resolutionResolved') },
    { value: 'false_positive', label: t('pages.anomalies.resolutionFalsePositive') },
    { value: 'accepted_risk',  label: t('pages.anomalies.resolutionAcceptedRisk') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Suggestion box */}
      {suggestion && (
        <div style={{
          background: 'var(--color-brand-light, #eff6ff)',
          borderLeft: `3px solid var(--color-brand)`,
          borderRadius: '0 6px 6px 0',
          padding: '10px 14px',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}>
          <Lightbulb size={15} color="var(--color-brand)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 13, color: colors.slateDark, lineHeight: 1.6 }}>
            {suggestion}
          </span>
        </div>
      )}

      {/* Resolution status dropdown */}
      <div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
          {t('pages.anomalies.actionLabel')}
        </label>
        <select
          value={resolutionStatus}
          onChange={(e) => setResolutionStatus(e.target.value)}
          style={{
            width: '100%', height: 36, fontSize: 13,
            border: `1px solid ${colors.border}`, borderRadius: 6,
            padding: '0 10px', background: 'var(--surface)',
            color: resolutionStatus ? colors.slateDark : colors.slateLight,
            cursor: 'pointer', appearance: 'auto',
          }}
        >
          <option value="" disabled>{t('pages.anomalies.actionPlaceholder')}</option>
          {resolutionOptions.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Note textarea */}
      <div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
          {t('pages.anomalies.noteLabel')}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('pages.anomalies.notePlaceholder')}
          rows={4}
          style={{
            width: '100%', fontSize: 13, lineHeight: 1.6,
            border: `1px solid ${colors.border}`, borderRadius: 6,
            padding: '8px 10px', resize: 'vertical',
            background: 'var(--surface)', color: colors.slateDark,
            boxSizing: 'border-box',
          }}
        />
        <div style={{ fontSize: 11, color: note.trim().length < 10 ? colors.slateLight : colors.success, marginTop: 4 }}>
          {t('pages.anomalies.minChars', { count: note.trim().length })}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: colors.danger, padding: '8px 12px', background: '#fff5f5', border: `1px solid ${colors.danger}`, borderRadius: 6 }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={!isValid || loading}
          onClick={() => onConfirm(resolutionStatus, note.trim())}
          style={{
            flex: 1, padding: '9px 14px', borderRadius: 6, border: 'none',
            background: isValid && !loading ? 'var(--color-brand)' : '#c4c9d4',
            color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: isValid && !loading ? 'pointer' : 'not-allowed',
            transition: 'background 150ms',
          }}
        >
          {loading ? t('pages.anomalies.saving') : t('pages.anomalies.confirmResolution')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          style={{
            padding: '9px 14px', borderRadius: 6,
            border: `1px solid ${colors.border}`, background: 'transparent',
            color: colors.slate, fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({
  anomaly,
  onClose,
  onResolve,
  loading,
  resolveError,
}: {
  anomaly: Anomaly
  onClose: () => void
  onResolve: (id: string, resolutionStatus: string, note: string) => void
  loading: boolean
  resolveError: string | null
}) {
  const { t } = useTranslation()
  const [showForm, setShowForm] = useState(false)

  const isOpen = anomaly.status === 'open'

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0,
      width: 420, background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
      zIndex: 100,
      overflowY: 'auto',
      padding: 24,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            {RULE_LABEL_KEYS[anomaly.ruleKey] ? t(RULE_LABEL_KEYS[anomaly.ruleKey]) : anomaly.ruleKey}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.slateDark, lineHeight: 1.4 }}>
            {anomaly.title}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, color: colors.slateLight }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <SeverityBadge value={anomaly.severity} />
        <AnomalyStatusBadge value={anomaly.status} />
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
        <Field label={t('pages.anomalies.entity')} value={`${anomaly.entityName} (${CI_TYPE_KEYS[anomaly.entitySubtype] ? t(CI_TYPE_KEYS[anomaly.entitySubtype]) : (anomaly.entitySubtype ?? anomaly.entityType)})`} />
        <Field label={t('common.description')} value={anomaly.description} />
        <Field label={t('pages.anomalies.detectedAtCol')} value={new Date(anomaly.detectedAt).toLocaleString()} />
        {anomaly.resolvedAt && (
          <Field label={t('common.resolvedAt')} value={new Date(anomaly.resolvedAt).toLocaleString()} />
        )}
        {anomaly.resolutionNote && (
          <Field label={t('common.note')} value={anomaly.resolutionNote} />
        )}
        {anomaly.resolvedBy && (
          <Field label={t('common.resolvedBy')} value={anomaly.resolvedBy} />
        )}
      </div>

      {/* Resolution */}
      {isOpen && !showForm && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          style={{
            width: '100%', padding: '9px 14px', borderRadius: 6, border: 'none',
            background: 'var(--color-brand)', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('pages.anomalies.resolveAnomaly')}
        </button>
      )}

      {isOpen && showForm && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.slateDark, marginBottom: 12 }}>
            {t('pages.anomalies.resolution')}
          </div>
          <ResolutionForm
            anomaly={anomaly}
            loading={loading}
            error={resolveError}
            onCancel={() => setShowForm(false)}
            onConfirm={(resolutionStatus, note) => onResolve(anomaly.id, resolutionStatus, note)}
          />
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: colors.slateDark, lineHeight: 1.6 }}>{value}</div>
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
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.slate, marginBottom: 6 }}>
          {t('pages.anomalies.noScanYet')}
        </div>
        <div style={{ fontSize: 13, color: colors.slateLight, maxWidth: 340, margin: '0 auto' }}>
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
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.slate, marginBottom: 6 }}>
        {t('pages.anomalies.noAnomalies')}
      </div>
      <div style={{ fontSize: 13, color: colors.slateLight, maxWidth: 360, margin: '0 auto' }}>
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
          <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 2 }}>
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
          <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 2 }}>
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
        <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>
          {new Date(String(v)).toLocaleString()}
        </span>
      ),
    },
  ]

  const ANOMALY_FILTER_FIELDS: FieldConfig[] = [
    { key: 'title',      label: t('common.title'),                    type: 'text' },
    { key: 'severity',   label: t('pages.anomalies.severity'),        type: 'enum', enumValues: ['critical', 'high', 'medium', 'low'] },
    { key: 'status',     label: t('pages.anomalies.status'),          type: 'enum', enumValues: ['open', 'resolved', 'false_positive', 'accepted_risk'] },
    { key: 'ruleKey',    label: t('pages.anomalies.type'),            type: 'enum', enumValues: ['orphan_ci', 'spof', 'dependency_cycle', 'missing_owner', 'unauthorized_relation', 'isolated_cluster', 'risk_concentration'] },
    { key: 'detectedAt', label: t('pages.anomalies.detectedAtCol'),   type: 'date' },
  ]
  const [mutLoading, setMutLoading]     = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [page, setPage]                 = useState(0)
  const [filterGroup, setFilterGroup]   = useState<FilterGroup | null>(null)

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
        limit:   PAGE_SIZE,
        offset:  page * PAGE_SIZE,
        filters: filterGroup ? JSON.stringify(filterGroup) : null,
      },
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="ty-page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldAlert size={22} color={colors.danger} />
            {t('pages.anomalies.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
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
            fontSize: 13, fontWeight: 600, cursor: scannerLoading ? 'not-allowed' : 'pointer',
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
            <div style={{ fontSize: 12, color: colors.slateLight, paddingLeft: 2 }}>
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
          />
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.anomalies.count', { count: total })}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.prev')}
            </button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: 'var(--color-slate)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}

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
    </div>
  )
}
