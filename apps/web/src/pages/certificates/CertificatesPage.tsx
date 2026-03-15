import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { GET_CERTIFICATES } from '@/graphql/queries'

interface CertificateItem {
  id: string; name: string; type: string; status: string | null; environment: string | null
  serialNumber: string | null; expiresAt: string | null; certificateType: string | null
  createdAt: string; ownerGroup: { id: string; name: string } | null
}

const PAGE_SIZE = 50

function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span style={{ color: '#c4cad4' }}>—</span>
  const now = new Date()
  const expiry = new Date(expiresAt)
  const diffMs = expiry.getTime() - now.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  let bg = '#ecfdf5', color = '#059669', label = 'Valido'
  if (diffMs < 0) { bg = '#fef2f2'; color = '#dc2626'; label = 'Scaduto' }
  else if (diffDays < 30) { bg = '#fff7ed'; color = '#ea580c'; label = 'In scadenza' }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600, backgroundColor: bg, color }}>{label}</span>
      <span style={{ fontSize: 11, color: '#8892a4' }}>{expiry.toLocaleDateString('it-IT')}</span>
    </div>
  )
}

export function CertificatesPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [queryFilters, setQueryFilters] = useState<Record<string, string>>({})

  const { data, loading } = useQuery<{ certificates: { items: CertificateItem[]; total: number } }>(GET_CERTIFICATES, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, ...queryFilters },
    fetchPolicy: 'cache-and-network',
  })

  const items = data?.certificates?.items ?? []
  const total = data?.certificates?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const COLUMNS: ColumnDef<CertificateItem>[] = [
    { key: 'name', label: 'Nome', sortable: true, filterable: true },
    { key: 'certificateType', label: 'Tipo', sortable: true, render: (v) => v as string || <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'expiresAt', label: 'Scadenza', sortable: true, render: (v) => <ExpiryBadge expiresAt={v as string | null} /> },
    { key: 'environment', label: 'Env', sortable: true, render: (v) => v ? <EnvBadge environment={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'status', label: 'Status', sortable: true, render: (v) => v ? <StatusBadge value={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span> },
    { key: 'ownerGroup', label: 'Owner Group', sortable: false, render: (v) => (v as CertificateItem['ownerGroup'])?.name ?? <span style={{ color: '#c4cad4' }}>—</span> },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>Certificati</h1>
        {total > 0 && <span style={{ fontSize: 13, color: '#8892a4' }}>{total} totali</span>}
      </div>
      {!loading && items.length === 0 ? (
        <EmptyState icon={<ShieldCheck size={32} color="#8892a4" />} title="Nessun certificato" />
      ) : (
        <SortableFilterTable columns={COLUMNS} data={items} loading={loading}
          onRowClick={(row) => navigate(`/certificates/${row.id}`)}
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
