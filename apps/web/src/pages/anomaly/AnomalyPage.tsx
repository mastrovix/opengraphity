import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { ShieldAlert, ShieldCheck, Radar, RefreshCw, X, Lightbulb } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import {
  GET_ANOMALIES, GET_ANOMALY_STATS, GET_ANOMALY_SCAN_STATUS,
  RESOLVE_ANOMALY, RUN_ANOMALY_SCANNER,
} from '@/graphql/queries'
import { colors } from '@/lib/tokens'

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

const CI_TYPE_LABEL: Record<string, string> = {
  application:       'Application',
  database:          'Database',
  database_instance: 'DB Instance',
  server:            'Server',
  certificate:       'Certificate',
  ci:                'CI',
}

const RULE_LABELS: Record<string, string> = {
  orphan_ci:             'CI Orfano',
  spof:                  'Single Point of Failure',
  dependency_cycle:      'Ciclo di Dipendenza',
  missing_owner:         'CI Senza Owner',
  unauthorized_relation: 'Relazione Non Autorizzata',
  isolated_cluster:      'Cluster Isolato',
  risk_concentration:    'Concentrazione di Rischio',
}

const RULE_SUGGESTIONS: Record<string, string> = {
  orphan_ci:
    'Questo CI non ha relazioni. Verifica se è ancora in uso — se no, considera di eliminarlo. Se è attivo, collegalo ai CI da cui dipende.',
  spof:
    'Questo CI è un Single Point of Failure — molti servizi dipendono da esso senza ridondanza. Considera di creare un Change per aggiungere un secondo nodo o un load balancer.',
  dependency_cycle:
    'Esiste un ciclo nelle dipendenze che può causare deadlock o problemi a catena. Rivedi le relazioni e rimuovi quella non necessaria.',
  missing_owner:
    'Nessun team è responsabile di questo CI. Assegna un team owner per garantire accountability in caso di incident.',
  unauthorized_relation:
    'Questa relazione è stata creata senza un Change approvato. Verifica se è legittima — se sì, crea un Change retroattivo. Se no, rimuovila.',
  isolated_cluster:
    'Questo gruppo di CI è disconnesso dal resto dell\'infrastruttura. Verifica se è intenzionale (es. ambiente test) o se mancano relazioni.',
  risk_concentration:
    'Troppi servizi critici sono concentrati su questo nodo. Considera di redistribuire i workload su più server per ridurre il rischio.',
}

const RESOLUTION_OPTIONS = [
  { value: 'resolved',        label: 'Risolto — ho fixato il problema' },
  { value: 'false_positive',  label: 'Falso positivo — non è un problema reale' },
  { value: 'accepted_risk',   label: 'Rischio accettato — consapevole, non richiede azione' },
]

// ── Status badge ──────────────────────────────────────────────────────────────

function AnomalyStatusBadge({ value }: { value: string }) {
  const map: Record<string, { color: string; label: string; weight?: number }> = {
    open:           { color: colors.danger,      label: 'Aperta',           weight: 600 },
    resolved:       { color: colors.success,     label: 'Risolta',          weight: 500 },
    false_positive: { color: colors.slateLight,  label: 'Falso positivo',   weight: 400 },
    accepted_risk:  { color: colors.slateLight,  label: 'Rischio accettato', weight: 400 },
  }
  const s = map[value] ?? { color: colors.slate, label: value, weight: 400 }
  return (
    <span style={{ fontSize: 12, fontWeight: s.weight, color: s.color }}>
      {s.label}
    </span>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid var(--border)`,
      borderRadius: 10,
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
  const [resolutionStatus, setResolutionStatus] = useState('')
  const [note, setNote]                         = useState('')

  const suggestion = RULE_SUGGESTIONS[anomaly.ruleKey]
  const isValid    = resolutionStatus !== '' && note.trim().length >= 10

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
          Azione *
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
          <option value="" disabled>Seleziona un'azione...</option>
          {RESOLUTION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Note textarea */}
      <div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
          Nota *
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Descrivi cosa hai fatto o perché non è un problema..."
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
          {note.trim().length} / 10 caratteri minimi
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
          {loading ? 'Salvataggio...' : 'Conferma risoluzione'}
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
          Annulla
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
            {RULE_LABELS[anomaly.ruleKey] ?? anomaly.ruleKey}
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
        <Field label="Entità"     value={`${anomaly.entityName} (${CI_TYPE_LABEL[anomaly.entitySubtype] ?? anomaly.entitySubtype})`} />
        <Field label="Descrizione" value={anomaly.description} />
        <Field label="Rilevata il" value={new Date(anomaly.detectedAt).toLocaleString('it-IT')} />
        {anomaly.resolvedAt && (
          <Field label="Risolta il" value={new Date(anomaly.resolvedAt).toLocaleString('it-IT')} />
        )}
        {anomaly.resolutionNote && (
          <Field label="Nota" value={anomaly.resolutionNote} />
        )}
        {anomaly.resolvedBy && (
          <Field label="Risolta da" value={anomaly.resolvedBy} />
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
          Risolvi anomalia
        </button>
      )}

      {isOpen && showForm && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.slateDark, marginBottom: 12 }}>
            Risoluzione
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
  const neverRun = !scanStatus?.lastScanAt

  if (neverRun) {
    return (
      <div style={{ textAlign: 'center', padding: '56px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <Radar size={44} color={colors.slateLight} />
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.slate, marginBottom: 6 }}>
          Scanner non ancora eseguito
        </div>
        <div style={{ fontSize: 13, color: colors.slateLight, maxWidth: 340, margin: '0 auto' }}>
          Clicca &ldquo;Esegui Scanner&rdquo; per analizzare il grafo CMDB e rilevare eventuali anomalie.
        </div>
      </div>
    )
  }

  const lastScan = new Date(scanStatus.lastScanAt!).toLocaleString('it-IT')
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <ShieldCheck size={44} color={colors.success} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.slate, marginBottom: 6 }}>
        Nessuna anomalia rilevata
      </div>
      <div style={{ fontSize: 13, color: colors.slateLight, maxWidth: 360, margin: '0 auto' }}>
        Il grafo CMDB è in salute. Ultima scansione: {lastScan}
      </div>
    </div>
  )
}

// ── Table columns ─────────────────────────────────────────────────────────────

const columns: ColumnDef<Anomaly>[] = [
  {
    key:        'title',
    label:      'Anomalia',
    sortable:   true,
    filterable: true,
    filterType: 'text',
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
    key:           'severity',
    label:         'Severity',
    width:         '120px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'critical', label: 'Critical' },
      { value: 'high',     label: 'High' },
      { value: 'medium',   label: 'Medium' },
      { value: 'low',      label: 'Low' },
    ],
    render: (v) => <SeverityBadge value={String(v)} />,
  },
  {
    key:           'status',
    label:         'Stato',
    width:         '130px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'open',           label: 'Aperta'          },
      { value: 'resolved',       label: 'Risolta'         },
      { value: 'false_positive', label: 'Falso positivo'  },
      { value: 'accepted_risk',  label: 'Rischio accettato' },
    ],
    render: (v) => <AnomalyStatusBadge value={String(v)} />,
  },
  {
    key:        'entityName',
    label:      'Entità',
    sortable:   true,
    filterable: true,
    filterType: 'text',
    render: (v, row) => (
      <div>
        <div style={{ color: 'var(--color-slate-dark)' }}>{String(v)}</div>
        <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 2 }}>
          {CI_TYPE_LABEL[row.entitySubtype] ?? row.entitySubtype ?? row.entityType}
        </div>
      </div>
    ),
  },
  {
    key:      'detectedAt',
    label:    'Rilevata il',
    width:    '160px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>
        {new Date(String(v)).toLocaleString('it-IT')}
      </span>
    ),
  },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export function AnomalyPage() {
  const [selected, setSelected]         = useState<Anomaly | null>(null)
  const [mutLoading, setMutLoading]     = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [page, setPage]                 = useState(0)
  const [queryFilters, setQueryFilters] = useState<Record<string, string>>({})

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
        limit:    PAGE_SIZE,
        offset:   page * PAGE_SIZE,
        status:   queryFilters['status']   || undefined,
        severity: queryFilters['severity'] || undefined,
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

  const handleFiltersChange = (filters: Record<string, string>) => {
    setQueryFilters(filters)
    setPage(0)
  }

  async function handleResolve(id: string, resolutionStatus: string, note: string) {
    setMutLoading(true)
    setResolveError(null)
    try {
      await resolveAnomaly({ variables: { id, resolutionStatus, note } })
      void refetch()
      void refetchStats()
      setSelected(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Errore durante la risoluzione. Riprova.'
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldAlert size={22} color={colors.danger} />
          <h1 className="ty-page-title">Anomalie</h1>
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
          Esegui Scanner
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatCard label="Aperte"   value={stats.open}     accent={colors.danger}                     />
            <StatCard label="Critical" value={stats.critical} accent={colors.severity.critical.text}     />
            <StatCard label="High"     value={stats.high}     accent={colors.severity.high.text}         />
            <StatCard label="Medium"   value={stats.medium}   accent={colors.severity.medium.text}       />
            <StatCard label="Low"      value={stats.low}      accent={colors.severity.low.text}          />
          </div>
          {(stats.falsePositive > 0 || stats.acceptedRisk > 0) && (
            <div style={{ fontSize: 12, color: colors.slateLight, paddingLeft: 2 }}>
              {[
                stats.falsePositive > 0 ? `${stats.falsePositive} false positive` : null,
                stats.acceptedRisk  > 0 ? `${stats.acceptedRisk} rischi accettati` : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
        {!loading && anomalies.length === 0 ? (
          <AnomalyEmptyState scanStatus={scanStatus} />
        ) : (
          <SortableFilterTable<Anomaly>
            data={anomalies}
            columns={columns}
            loading={loading}
            onRowClick={(row) => setSelected(row)}
            onFiltersChange={handleFiltersChange}
          />
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} di {total} anomalie
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              ← Prev
            </button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: 'var(--color-slate)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              Next →
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
