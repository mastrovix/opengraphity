import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import { ShieldCheck } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { alpha, colors, palette } from '@/lib/tokens'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { formatDateTime } from '@/lib/datetime'

/**
 * Le azioni presenti nel registro di audit, con quante voci ciascuna: la
 * tendina del filtro le offre invece di chiedere all'amministratore di
 * indovinarle. Dopo il taglio di vocabolario dell'ondata 4 (le transizioni di
 * workflow sono sotto `<entità>.step_entered`, prima sotto il nome del passo)
 * le voci storiche non sono state riscritte — è un registro di conformità — e
 * questa lista le mostra comunque, così la storia si ritrova tutta.
 */
/**
 * Anche i TIPI DI ENTITÀ vengono dal registro (revisione totale · G-20): il
 * filtro era una lista di sette valori scritta qui, con etichette letterali e
 * senza le richieste di servizio, i CI, i vocabolari, i workflow, le mappe —
 * voci che esistevano nel registro e non si potevano isolare.
 */
const GET_AUDIT_ACTIONS = gql`
  query GetAuditActions {
    auditEntityTypes { entityType count }
    auditActions { action count }
  }
`

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
  const { labelOf: typeLabel } = useItilTypeLabels()

  const [page, setPage]             = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortField, setSortField]   = useState<string | null>(null)
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction); setPage(0) }
  // Le azioni presenti nel registro, dal server: la tendina le offre invece di
  // chiedere di indovinarle a testo libero. Dopo il taglio di vocabolario
  // dell'ondata 4 (le transizioni di workflow sono sotto
  // `<entità>.step_entered`, prima sotto il nome del passo) le voci storiche
  // NON sono state riscritte — è un registro di conformità — quindi qui
  // compaiono entrambe le metà della storia e nessuna diventa introvabile.
  const actionsQuery = useQuery<{ auditActions: { action: string; count: number }[]; auditEntityTypes: { entityType: string; count: number }[] }>(
    GET_AUDIT_ACTIONS, { fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  const actionOptions = (actionsQuery.data?.auditActions ?? [])
    .map(({ action, count }) => ({ value: action, label: `${action} (${count})` }))
  /** G-20: le etichette dei tipi ITIL sono quelle del cliente, le altre il nome tecnico. */
  const ITIL_AUDIT_LABELS: Record<string, string> = {
    Incident: typeLabel('incident'), Change: typeLabel('change'),
    Problem: typeLabel('problem'), ServiceRequest: typeLabel('service_request'),
  }
  const entityTypeOptions = (actionsQuery.data?.auditEntityTypes ?? [])
    .map(({ entityType, count }) => ({ value: entityType, label: `${ITIL_AUDIT_LABELS[entityType] ?? entityType} (${count})` }))

  const AUDIT_FILTER_FIELDS: FieldConfig[] = [
    // `text` finché le azioni non sono arrivate: meglio un filtro che funziona
    // a testo libero che una tendina vuota.
    actionOptions.length > 0
      ? { key: 'action', label: t('pages.audit.colAction'), type: 'enum', options: actionOptions }
      : { key: 'action', label: t('pages.audit.colAction'), type: 'text' },
    // G-20: i tipi presenti nel registro, col loro conteggio. Il nome dei tipi
    // ITIL resta quello del cliente (F16); per gli altri vale l'etichetta
    // Neo4j, che è il nome tecnico con cui l'audit li registra.
    entityTypeOptions.length > 0
      ? { key: 'entityType', label: t('pages.audit.colEntityType'), type: 'enum', options: entityTypeOptions }
      : { key: 'entityType', label: t('pages.audit.colEntityType'), type: 'text' },
    { key: 'userEmail', label: t('pages.audit.colUserEmail'), type: 'text' },
    { key: 'createdAt', label: t('pages.audit.colDate'), type: 'date' },
  ]

  // Variables derived from state: every change of page/sort/filter re-runs the
  // query with the CURRENT values — no lazy query reading a stale closure (E-04).
  const { data, loading, error, refetch } = useQuery<
    { auditLog: { items: AuditEntry[]; total: number } }
  >(GET_AUDIT_LOG, {
    fetchPolicy: 'network-only',
    variables: {
      page:          page + 1,  // API is 1-based
      pageSize:      PAGE_SIZE,
      sortField:     sortField || undefined,
      sortDirection: sortDir,
      filters:       filterGroup ? JSON.stringify(filterGroup) : undefined,
    },
  })

  const items: AuditEntry[] = data?.auditLog?.items ?? []
  const total: number       = data?.auditLog?.total  ?? 0
  const totalPages          = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const columns: ColumnDef<AuditEntry>[] = [
    {
      key: 'createdAt', label: t('pages.audit.colDate'), sortable: true,
      render: (v) => (
        <span style={{ color: 'var(--color-slate-light)' }}>
          {formatDateTime(v as string)}
        </span>
      ),
    },
    { key: 'userEmail',  label: t('pages.audit.colUser'),       sortable: true },
    { key: 'action',     label: t('pages.audit.colAction'),     sortable: true },
    { key: 'entityType', label: t('pages.audit.colEntityType'), sortable: true },
    {
      key: 'entityId', label: t('pages.audit.colEntityId'), sortable: false,
      render: (v) => <code style={{ fontSize: 'var(--font-size-table)' }}>{String(v).slice(0, 8)}…</code>,
    },
    {
      key: 'ipAddress', label: t('pages.audit.colIp'), sortable: false,
      render: (v) => v ? String(v) : <span style={{ color: palette.neutral.borderStrong }}>—</span>,
    },
  ]

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<ShieldCheck size={22} color="var(--color-icon-accent)" />}>
            {t('pages.audit.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.audit.count', { count: total })}
          </p>
        </div>
      </div>

      {/* Advanced filters — the group is state, the query follows it */}
      <FilterBuilder fields={AUDIT_FILTER_FIELDS} onApply={g => { setFilterGroup(g); setPage(0) }} />

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          {error && (
            <div style={{ padding: '12px 16px', borderRadius: 8, background: alpha.danger08, color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', marginBottom: 16 }}>
              {error.message}
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
              <div style={{ marginTop: 12, padding: 16, background: 'var(--color-slate-bg)', borderRadius: 8, border: `1px solid ${colors.border}` }}>
                <strong style={{ fontSize: 'var(--font-size-body)' }}>{t('pages.audit.details', { action: entry.action })}</strong>
                <pre style={{ marginTop: 8, fontSize: 'var(--font-size-body)', overflowX: 'auto', margin: '8px 0 0 0' }}>
                  {JSON.stringify(parsed, null, 2)}
                </pre>
              </div>
            )
          })()}

          {/* Pagination */}
          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        </>
      )}
    </PageContainer>
  )
}
