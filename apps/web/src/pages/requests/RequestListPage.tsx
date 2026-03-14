import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'

interface ServiceRequest {
  id:        string
  title:     string
  priority:  string
  status:    string
  createdAt: string
}

const columns: ColumnDef<ServiceRequest>[] = [
  {
    key:         'title',
    label:       'Title',
    sortable:    true,
    filterable:  true,
    filterType:  'text',
  },
  {
    key:           'priority',
    label:         'Priority',
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
      { value: 'fulfilled',   label: 'Fulfilled' },
      { value: 'closed',      label: 'Closed' },
      { value: 'cancelled',   label: 'Cancelled' },
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

export function RequestListPage() {
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ serviceRequests: ServiceRequest[] }>(GET_SERVICE_REQUESTS)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            Service Requests
          </h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${data?.serviceRequests?.length ?? 0} total`}
          </p>
        </div>
        <button
          onClick={() => navigate('/requests/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          New Request
        </button>
      </div>

      <SortableFilterTable<ServiceRequest>
        columns={columns}
        data={data?.serviceRequests ?? []}
        loading={loading}
        emptyMessage="Nessuna richiesta trovata"
      />
    </div>
  )
}
