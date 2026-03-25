import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { Users } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

interface Team {
  id:          string
  name:        string
  description: string | null
  type:        string | null
  createdAt:   string
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const styles: Record<string, { bg: string; color: string }> = {
    owner:   { bg: '#eff6ff', color: '#2563eb' },
    support: { bg: '#f0fdf4', color: '#16a34a' },
  }
  const s = styles[type] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{ fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {type}
    </span>
  )
}

const PAGE_SIZE = 50

const FILTER_FIELDS: FieldConfig[] = [
  { key: 'name',      label: 'Nome',      type: 'text' },
  { key: 'createdAt', label: 'Creato il', type: 'date' },
]

const COLUMNS: ColumnDef<Team>[] = [
  { key: 'name',        label: 'Nome',        sortable: true },
  { key: 'description', label: 'Descrizione', sortable: false },
  {
    key:    'type',
    label:  'Tipo',
    sortable: true,
    render: (v) => <TypeBadge type={v as string | null} />,
  },
  {
    key:    'createdAt',
    label:  'Creato il',
    sortable: true,
    render: (v) => v ? new Date(v as string).toLocaleDateString('it-IT') : '—',
  },
]

export function TeamsPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const { data, loading } = useQuery<{ teams: Team[] }>(GET_TEAMS, {
    variables: { filters: filterGroup ? JSON.stringify(filterGroup) : null },
    fetchPolicy: 'cache-and-network',
  })

  const teams      = data?.teams ?? []
  const total      = teams.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = teams.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div style={{ padding: '32px 40px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>Teams</h1>
        <button
          disabled
          style={{
            padding:         '8px 16px',
            background:      'var(--color-brand)',
            color:           '#fff',
            border:          'none',
            borderRadius:    6,
            fontSize:        13,
            fontWeight:      600,
            cursor:          'not-allowed',
            opacity:         0.4,
          }}
        >
          New
        </button>
      </div>

      <FilterBuilder
        fields={FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      {/* Table */}
      {!loading && teams.length === 0 ? (
        <EmptyState
          icon={<Users size={32} color="var(--color-slate-light)" />}
          title="Nessun team"
          description="Non ci sono team per questo tenant."
        />
      ) : (
        <SortableFilterTable
          columns={COLUMNS}
          data={pageItems}
          loading={loading}
          onRowClick={(row) => navigate(`/teams/${row.id}`)}
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
