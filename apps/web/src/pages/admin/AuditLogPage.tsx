import { useState, useEffect } from 'react'
import { gql } from '@apollo/client'
import { useLazyQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { EmptyState } from '@/components/EmptyState'

const GET_AUDIT_LOG = gql`
  query GetAuditLog(
    $page: Int, $pageSize: Int,
    $filters: String,
    $sortField: String, $sortDirection: String
  ) {
    auditLog(
      page: $page, pageSize: $pageSize,
      filters: $filters,
      sortField: $sortField, sortDirection: $sortDirection
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

export function AuditLogPage() {
  const { t } = useTranslation()

  const [page, setPage]             = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortField, setSortField]   = useState<string | null>(null)
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction); setPage(0) }
  const AUDIT_FILTER_FIELDS: FieldConfig[] = [
    { key: 'action', label: 'Azione', type: 'text' },
    { key: 'entityType', label: 'Tipo entità', type: 'enum', options: [
      { value: 'Incident', label: 'Incident' }, { value: 'Change', label: 'Change' },
      { value: 'Problem', label: 'Problem' }, { value: 'User', label: 'User' },
      { value: 'Team', label: 'Team' }, { value: 'AutoTrigger', label: 'Trigger' },
      { value: 'BusinessRule', label: 'Business Rule' },
    ]},
    { key: 'userEmail', label: 'Utente (email)', type: 'text' },
    { key: 'createdAt', label: 'Data', type: 'date' },
  ]

  const [executeQuery, { data, loading, error }] = useLazyQuery<
    { auditLog: { items: AuditEntry[]; total: number } }
  >(GET_AUDIT_LOG, { fetchPolicy: 'network-only' })

  const runQuery = (opts: { page?: number } = {}) => {
    void executeQuery({
      variables: {
        page:       (opts.page ?? page) + 1,  // API is 1-based
        pageSize:   PAGE_SIZE,
        sortField:  sortField || undefined,
        sortDirection: sortDir,
        filters: filterGroup ? JSON.stringify(filterGroup) : undefined,
      },
    })
  }

  // Load data on mount
  useEffect(() => { runQuery() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
    runQuery({ page: newPage })
  }

  const items: AuditEntry[] = data?.auditLog?.items ?? []
  const total: number       = data?.auditLog?.total  ?? 0
  const totalPages          = Math.max(1, Math.ceil(total / PAGE_SIZE))

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
      render: (v) => <code style={{ fontSize: 'var(--font-size-table)' }}>{String(v).slice(0, 8)}…</code>,
    },
    {
      key: 'ipAddress', label: t('pages.audit.colIp'), sortable: false,
      render: (v) => v ? String(v) : <span style={{ color: '#c4cad4' }}>—</span>,
    },
  ]

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<ShieldCheck size={22} color="#38bdf8" />}>
            {t('pages.audit.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} ${t('pages.audit.entries')}`}
          </p>
        </div>
      </div>

      {/* Advanced filters — replaces standalone dropdowns */}
      <FilterBuilder fields={AUDIT_FILTER_FIELDS} onApply={g => { setFilterGroup(g); runQuery({ page: 0 }) }} />

      {/* Error */}
      {error && (
        <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 'var(--font-size-body)', marginBottom: 16 }}>
          {(error as { graphQLErrors?: Array<{ message: string }> }).graphQLErrors?.[0]?.message ?? error.message}
        </div>
      )}

      {/* Table */}
      <SortableFilterTable<AuditEntry>
        columns={columns}
        data={items}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
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
            <strong style={{ fontSize: 'var(--font-size-body)' }}>{t('pages.audit.details', { action: entry.action })}</strong>
            <pre style={{ marginTop: 8, fontSize: 'var(--font-size-body)', overflowX: 'auto', margin: '8px 0 0 0' }}>
              {JSON.stringify(parsed, null, 2)}
            </pre>
          </div>
        )
      })()}

      {/* Pagination */}
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.audit.entries')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => handlePageChange(Math.max(0, page - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.prev')}
            </button>
            <span style={{ padding: '4px 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => handlePageChange(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
