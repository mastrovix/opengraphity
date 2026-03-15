import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { GET_INCIDENTS } from '@/graphql/queries'

interface Incident {
  id:        string
  title:     string
  severity:  string
  status:    string
  createdAt: string
}

const columns: ColumnDef<Incident>[] = [
  {
    key:         'title',
    label:       'Title',
    sortable:    true,
    filterable:  true,
    filterType:  'text',
  },
  {
    key:           'severity',
    label:         'Severity',
    width:         '130px',
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
    label:         'Status',
    width:         '130px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'open',        label: 'Open' },
      { value: 'in_progress', label: 'In Progress' },
      { value: 'resolved',    label: 'Resolved' },
      { value: 'closed',      label: 'Closed' },
    ],
    render: (v) => <StatusBadge value={String(v)} />,
  },
  {
    key:      'createdAt',
    label:    'Created',
    width:    '120px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: '#8892a4', fontSize: 13 }}>
        {new Date(String(v)).toLocaleDateString()}
      </span>
    ),
  },
]

const PAGE_SIZE = 50

export function IncidentListPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [queryFilters, setQueryFilters] = useState<Record<string, string>>({})

  const { data, loading } = useQuery<{
    incidents: { items: Incident[]; total: number }
  }>(GET_INCIDENTS, {
    variables: {
      limit:    PAGE_SIZE,
      offset:   page * PAGE_SIZE,
      status:   queryFilters['status']   || undefined,
      severity: queryFilters['severity'] || undefined,
    },
  })

  const items = data?.incidents?.items ?? []
  const total = data?.incidents?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const handleFiltersChange = (filters: Record<string, string>) => {
    setQueryFilters(filters)
    setPage(0)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            Incidents
          </h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} total`}
          </p>
        </div>
        <button
          onClick={() => navigate('/incidents/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          New Incident
        </button>
      </div>

      <SortableFilterTable<Incident>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<AlertCircle size={32} />} title="Nessun incident trovato" description="Apri un nuovo incident o modifica i filtri applicati." />}
        onRowClick={(row) => navigate(`/incidents/${row.id}`)}
        onFiltersChange={handleFiltersChange}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 13, color: '#8892a4' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} di {total} incidents
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : '#374151', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              ← Prev
            </button>
            <span style={{ padding: '4px 8px', fontSize: 13, color: '#6b7280' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : '#374151', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
