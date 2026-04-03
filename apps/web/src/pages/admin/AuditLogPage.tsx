import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { SortableFilterTable } from '@/components/SortableFilterTable'

import type { ColumnDef } from '@/components/SortableFilterTable'

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

const ACTION_OPTIONS = [
  '', 'incident.created', 'change.transitioned', 'sync_source.created',
  'sync_source.deleted', 'sync.triggered', 'sync_conflict.resolved',
  'anomaly.resolved', 'ci.deleted',
]

const ENTITY_OPTIONS = [
  '', 'Incident', 'Change', 'Problem', 'SyncSource', 'SyncRun',
  'SyncConflict', 'Anomaly', 'ConfigurationItem',
]

export function AuditLogPage() {
  const [page, setPage]               = useState(1)
  const [action, setAction]           = useState('')
  const [entityType, setEntityType]   = useState('')
  const [fromDate, setFromDate]       = useState('')
  const [toDate, setToDate]           = useState('')
  const [expandedId, setExpandedId]   = useState<string | null>(null)

  const { data, loading } = useQuery<{ auditLog: { items: AuditEntry[]; total: number } }>(GET_AUDIT_LOG, {
    variables: {
      page,
      pageSize: 50,
      action:     action     || undefined,
      entityType: entityType || undefined,
      fromDate:   fromDate   || undefined,
      toDate:     toDate     || undefined,
    },
    fetchPolicy: 'cache-and-network',
  })

  const items: AuditEntry[] = data?.auditLog?.items ?? []
  const total: number       = data?.auditLog?.total  ?? 0

  const columns: ColumnDef<AuditEntry>[] = [
    {
      key: 'createdAt', label: 'Data', sortable: false,
      render: (v) => new Date(v as string).toLocaleString('it-IT'),
    },
    { key: 'userEmail',  label: 'Utente',       sortable: false },
    { key: 'action',     label: 'Azione',        sortable: false },
    { key: 'entityType', label: 'Tipo Entità',   sortable: false },
    { key: 'entityId',   label: 'ID Entità',     sortable: false, render: (v) => <code style={{ fontSize: 11 }}>{String(v).slice(0, 8)}…</code> },
    { key: 'ipAddress',  label: 'IP',            sortable: false, render: (v) => v ? String(v) : '—' },
  ]

  const filterStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0',
    fontSize: 13, background: '#fff', color: '#1a2332',
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Audit Log</h1>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <select style={filterStyle} value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }}
          aria-label="Filtra per azione">
          {ACTION_OPTIONS.map((a) => <option key={a} value={a}>{a || '— Tutte le azioni —'}</option>)}
        </select>
        <select style={filterStyle} value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1) }}
          aria-label="Filtra per tipo entità">
          {ENTITY_OPTIONS.map((e) => <option key={e} value={e}>{e || '— Tutti i tipi —'}</option>)}
        </select>
        <input type="date" style={filterStyle} value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(1) }}
          aria-label="Data da" />
        <input type="date" style={filterStyle} value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(1) }}
          aria-label="Data a" />
        {(action || entityType || fromDate || toDate) && (
          <button style={{ ...filterStyle, cursor: 'pointer', background: '#f1f3f9' }}
            onClick={() => { setAction(''); setEntityType(''); setFromDate(''); setToDate(''); setPage(1) }}>
            Rimuovi filtri
          </button>
        )}
      </div>

      <SortableFilterTable<AuditEntry>
        columns={columns}
        data={items}
        loading={loading}
        label="Audit log operazioni"
        onRowClick={(row) => setExpandedId(expandedId === row.id ? null : row.id)}
        emptyMessage="Nessuna voce di audit trovata"
      />

      {/* Expanded detail */}
      {expandedId && (() => {
        const entry = items.find((i) => i.id === expandedId)
        if (!entry || !entry.details) return null
        let parsed: unknown
        try { parsed = JSON.parse(entry.details) } catch { parsed = entry.details }
        return (
          <div style={{ marginTop: 12, padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
            <strong style={{ fontSize: 13 }}>Dettagli — {entry.action}</strong>
            <pre style={{ marginTop: 8, fontSize: 12, overflowX: 'auto' }}>
              {JSON.stringify(parsed, null, 2)}
            </pre>
          </div>
        )
      })()}

      {/* Pagination */}
      {total > 50 && (
        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
            style={{ padding: '4px 12px', cursor: page === 1 ? 'not-allowed' : 'pointer' }}
            aria-label="Pagina precedente">
            ←
          </button>
          <span>Pagina {page} · {total} totali</span>
          <button disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}
            style={{ padding: '4px 12px', cursor: page * 50 >= total ? 'not-allowed' : 'pointer' }}
            aria-label="Pagina successiva">
            →
          </button>
        </div>
      )}
    </div>
  )
}
