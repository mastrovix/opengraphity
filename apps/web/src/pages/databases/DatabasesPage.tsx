import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { Database } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { GET_DATABASES } from '@/graphql/queries'

interface DatabaseItem {
  id: string; name: string; type: string; status: string | null
  environment: string | null; port: string | null; instanceType: string | null; createdAt: string
  ownerGroup: { id: string; name: string } | null
}

const PAGE_SIZE = 50

export function DatabasesPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [queryFilters, setQueryFilters] = useState<Record<string, string>>({})

  const { data, loading } = useQuery<{ databases: { items: DatabaseItem[]; total: number } }>(GET_DATABASES, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, ...queryFilters },
    fetchPolicy: 'cache-and-network',
  })

  const items = data?.databases?.items ?? []
  const total = data?.databases?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const COLUMNS: ColumnDef<DatabaseItem>[] = [
    { key: 'name', label: 'Nome', sortable: true, filterable: true },
    { key: 'instanceType', label: 'Instance Type', sortable: true, render: (v) => v as string || <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'port', label: 'Port', sortable: false, render: (v) => v as string || <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'environment', label: 'Env', sortable: true, render: (v) => v ? <EnvBadge environment={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'status', label: 'Status', sortable: true, render: (v) => v ? <StatusBadge value={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'ownerGroup', label: 'Owner Group', sortable: false, render: (v) => (v as DatabaseItem['ownerGroup'])?.name ?? <span style={{ color: '#c4cad4' }}>—</span> },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>Database</h1>
        {total > 0 && <span style={{ fontSize: 13, color: '#8892a4' }}>{total} totali</span>}
      </div>
      {!loading && items.length === 0 ? (
        <EmptyState icon={<Database size={32} color="#8892a4" />} title="Nessun database" />
      ) : (
        <SortableFilterTable columns={COLUMNS} data={items} loading={loading}
          onRowClick={(row) => navigate(`/databases/${row.id}`)}
          onFiltersChange={(f) => { setQueryFilters(f); setPage(0) }} />
      )}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 13 }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page === 0 ? 'not-allowed' : 'pointer', opacity: page === 0 ? 0.4 : 1 }}>← Prev</button>
          <span>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Next →</button>
        </div>
      )}
    </div>
  )
}
