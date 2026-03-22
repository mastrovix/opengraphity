import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { User } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_USERS } from '@/graphql/queries'

interface UserRow {
  id:        string
  name:      string
  email:     string
  role:      string
  createdAt: string | null
}

const ROLE_STYLES: Record<string, { bg: string; color: string }> = {
  admin:    { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  operator: { bg: '#eff6ff', color: '#2563eb' },
  viewer:   { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' },
}

function RoleBadge({ role }: { role: string }) {
  const s = ROLE_STYLES[role] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {role}
    </span>
  )
}

const PAGE_SIZE = 50

const COLUMNS: ColumnDef<UserRow>[] = [
  { key: 'name',  label: 'Nome',  sortable: true, filterable: true },
  { key: 'email', label: 'Email', sortable: true, filterable: true },
  {
    key:    'role',
    label:  'Ruolo',
    sortable: true,
    render: (v) => <RoleBadge role={v as string} />,
  },
  {
    key:     'createdAt',
    label:   'Creato il',
    sortable: true,
    render:  (v) => v ? new Date(v as string).toLocaleDateString('it-IT') : '—',
  },
]

export function UsersPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)

  const { data, loading } = useQuery<{ users: UserRow[] }>(GET_USERS, {
    fetchPolicy: 'cache-and-network',
  })

  const users      = data?.users ?? []
  const total      = users.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = users.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div style={{ padding: '32px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>Users</h1>
          {total > 0 && (
            <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>{total} totali</span>
          )}
        </div>
      </div>

      {/* Table */}
      {!loading && users.length === 0 ? (
        <EmptyState
          icon={<User size={32} color="var(--color-slate-light)" />}
          title="Nessun utente"
          description="Non ci sono utenti per questo tenant."
        />
      ) : (
        <SortableFilterTable
          columns={COLUMNS}
          data={pageItems}
          loading={loading}
          onRowClick={(row) => navigate(`/users/${row.id}`)}
        />
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 12, color: "var(--color-slate)" }}>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page === 0 ? 'not-allowed' : 'pointer', opacity: page === 0 ? 0.4 : 1 }}
          >
            ← Prev
          </button>
          <span>{page + 1} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
