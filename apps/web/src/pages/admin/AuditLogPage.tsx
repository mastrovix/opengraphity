import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'

const GET_AUDIT_LOG = gql`
  query GetAuditLog(
    $page: Int, $pageSize: Int,
    $action: String, $entityType: String,
    $fromDate: String, $toDate: String
  ) {
    auditLog(
      page: $page, pageSize: $pageSize,
      action: $action, entityType: $entityType,
      fromDate: $fromDate, toDate: $toDate
    ) {
      items {
        id userId userEmail action entityType entityId details ipAddress createdAt
      }
      total
    }
  }
`

interface AuditEntry {
  id: string
  userId: string
  userEmail: string
  action: string
  entityType: string
  entityId: string
  details: string | null
  ipAddress: string | null
  createdAt: string
}

const PAGE_SIZE = 50

// Actions grouped by entity type — drives the synced filter logic
const ENTITY_ACTIONS: Record<string, string[]> = {
  Incident:           ['incident.created', 'incident.assigned', 'incident.in_progress',
                       'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed'],
  Change:             ['change.created', 'change.approved', 'change.rejected', 'change.completed',
                       'change.failed', 'change.transitioned', 'change.task_assigned', 'change.task_completed'],
  Problem:            ['problem.created', 'problem.updated', 'problem.deleted',
                       'problem.under_investigation', 'problem.deferred', 'problem.resolved',
                       'problem.closed', 'problem.change_requested', 'problem.rejected'],
  ServiceRequest:     ['request.created', 'request.updated', 'request.resolved', 'request.closed'],
  ConfigurationItem:  ['ci.created', 'ci.updated', 'ci.deleted'],
  Team:               ['team.created', 'team.updated', 'team.member_added', 'team.member_removed'],
  Workflow:           ['workflow.created', 'workflow.updated', 'workflow.transition'],
  Dashboard:          ['dashboard.created', 'dashboard.updated', 'dashboard.deleted'],
  Report:             ['report.created', 'report.updated', 'report.deleted'],
  NotificationRule:   ['notification_rule.created', 'notification_rule.updated', 'notification_rule.deleted'],
  SyncSource:         ['sync_source.created', 'sync_source.updated', 'sync_source.deleted'],
  SyncRun:            ['sync.triggered'],
  SyncConflict:       ['sync_conflict.resolved'],
  Anomaly:            ['anomaly.resolved', 'anomaly.scan_triggered'],
  EnumTypeDefinition: ['enum_type.created', 'enum_type.updated', 'enum_type.deleted'],
}

const ALL_ACTIONS = Object.values(ENTITY_ACTIONS).flat().filter(
  (a, i, arr) => arr.indexOf(a) === i,
)

// Reverse map: action → primary entity (first entity in ENTITY_ACTIONS wins)
const ACTION_TO_ENTITY: Record<string, string> = {}
for (const [entity, actions] of Object.entries(ENTITY_ACTIONS)) {
  for (const a of actions) {
    if (!ACTION_TO_ENTITY[a]) ACTION_TO_ENTITY[a] = entity
  }
}

const ENTITY_OPTIONS = [
  '', 'Incident', 'Change', 'Problem', 'ServiceRequest', 'ConfigurationItem',
  'Team', 'Workflow', 'Dashboard', 'Report', 'NotificationRule',
  'SyncSource', 'SyncRun', 'SyncConflict', 'Anomaly', 'EnumTypeDefinition',
]

const selectStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0',
  fontSize: 13, background: '#fff', color: '#1a2332', cursor: 'pointer',
}

export function AuditLogPage() {
  const { t } = useTranslation()

  const [page, setPage]             = useState(0)
  const [action, setAction]         = useState('')
  const [entityType, setEntityType] = useState('')
  const [fromDate, setFromDate]     = useState('')
  const [toDate, setToDate]         = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Synced filter handlers
  const handleEntityChange = (newEntity: string) => {
    setEntityType(newEntity)
    setPage(0)
    if (!newEntity) {
      // "All types" → reset action too
      setAction('')
    } else if (action && !ENTITY_ACTIONS[newEntity]?.includes(action)) {
      // Current action doesn't belong to new entity → clear it
      setAction('')
    }
  }

  const handleActionChange = (newAction: string) => {
    setAction(newAction)
    setPage(0)
    if (!newAction) {
      // "All actions" → reset entity too
      setEntityType('')
    } else {
      // Auto-select entity from action
      const inferred = ACTION_TO_ENTITY[newAction]
      if (inferred) setEntityType(inferred)
    }
  }

  // Actions visible in dropdown: filtered to selected entity, or all
  const availableActions = entityType ? (ENTITY_ACTIONS[entityType] ?? ALL_ACTIONS) : ALL_ACTIONS

  const { data, loading } = useQuery<{ auditLog: { items: AuditEntry[]; total: number } }>(
    GET_AUDIT_LOG,
    {
      variables: {
        page:       page + 1,   // API is 1-based
        pageSize:   PAGE_SIZE,
        action:     action     || undefined,
        entityType: entityType || undefined,
        fromDate:   fromDate   || undefined,
        toDate:     toDate     || undefined,
      },
      fetchPolicy: 'cache-and-network',
    },
  )

  const items: AuditEntry[] = data?.auditLog?.items ?? []
  const total: number       = data?.auditLog?.total  ?? 0
  const totalPages          = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const hasFilters = !!(action || entityType || fromDate || toDate)

  const columns: ColumnDef<AuditEntry>[] = [
    {
      key: 'createdAt', label: t('pages.audit.colDate'), sortable: false,
      render: (v) => (
        <span style={{ color: 'var(--color-slate-light)' }}>
          {new Date(v as string).toLocaleString()}
        </span>
      ),
    },
    { key: 'userEmail',  label: t('pages.audit.colUser'),       sortable: false },
    { key: 'action',     label: t('pages.audit.colAction'),     sortable: false },
    { key: 'entityType', label: t('pages.audit.colEntityType'), sortable: false },
    {
      key: 'entityId', label: t('pages.audit.colEntityId'), sortable: false,
      render: (v) => <code style={{ fontSize: 11 }}>{String(v).slice(0, 8)}…</code>,
    },
    {
      key: 'ipAddress', label: t('pages.audit.colIp'), sortable: false,
      render: (v) => v ? String(v) : <span style={{ color: '#c4cad4' }}>—</span>,
    },
  ]

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldCheck size={22} color="var(--color-brand)" />
            {t('pages.audit.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} ${t('pages.audit.entries')}`}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' }}>
        <select
          style={selectStyle}
          value={entityType}
          onChange={(e) => handleEntityChange(e.target.value)}
          aria-label={t('pages.audit.filterByEntityType')}
        >
          {ENTITY_OPTIONS.map((e) => (
            <option key={e} value={e}>{e || t('pages.audit.allTypes')}</option>
          ))}
        </select>

        <select
          style={selectStyle}
          value={action}
          onChange={(e) => handleActionChange(e.target.value)}
          aria-label={t('pages.audit.filterByAction')}
        >
          <option value="">{t('pages.audit.allActions')}</option>
          {entityType
            ? availableActions.map((a) => <option key={a} value={a}>{a}</option>)
            : Object.entries(ENTITY_ACTIONS).map(([group, actions]) => (
                <optgroup key={group} label={group}>
                  {actions.map((a) => <option key={a} value={a}>{a}</option>)}
                </optgroup>
              ))
          }
        </select>

        <input
          type="date"
          style={selectStyle}
          value={fromDate}
          onChange={(e) => { setFromDate(e.target.value); setPage(0) }}
          aria-label={t('pages.audit.dateFrom')}
          title={t('pages.audit.dateFrom')}
        />

        <input
          type="date"
          style={selectStyle}
          value={toDate}
          onChange={(e) => { setToDate(e.target.value); setPage(0) }}
          aria-label={t('pages.audit.dateTo')}
          title={t('pages.audit.dateTo')}
        />

        {hasFilters && (
          <button
            style={{ ...selectStyle, cursor: 'pointer', background: '#f1f3f9', color: 'var(--color-slate)' }}
            onClick={() => { setAction(''); setEntityType(''); setFromDate(''); setToDate(''); setPage(0) }}
          >
            {t('pages.audit.removeFilters')}
          </button>
        )}
      </div>

      {/* Table */}
      <SortableFilterTable<AuditEntry>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={
          <EmptyState
            icon={<ShieldCheck size={32} color="var(--color-slate-light)" />}
            title={t('pages.audit.empty')}
          />
        }
        onRowClick={(row) => setExpandedId(expandedId === row.id ? null : row.id)}
      />

      {/* Expanded detail */}
      {expandedId && (() => {
        const entry = items.find((i) => i.id === expandedId)
        if (!entry?.details) return null
        let parsed: unknown
        try { parsed = JSON.parse(entry.details) } catch { parsed = entry.details }
        return (
          <div style={{ marginTop: 12, padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
            <strong style={{ fontSize: 13 }}>{t('pages.audit.details', { action: entry.action })}</strong>
            <pre style={{ marginTop: 8, fontSize: 12, overflowX: 'auto', margin: '8px 0 0 0' }}>
              {JSON.stringify(parsed, null, 2)}
            </pre>
          </div>
        )
      })()}

      {/* Pagination */}
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.audit.entries')}
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
    </div>
  )
}
