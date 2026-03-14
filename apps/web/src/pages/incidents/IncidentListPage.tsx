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
    key:    'id',
    label:  'ID',
    width:  '100px',
    render: (v) => (
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: '#8892a4' }}>
        {String(v).slice(0, 8)}
      </span>
    ),
  },
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

export function IncidentListPage() {
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ incidents: Incident[] }>(GET_INCIDENTS)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            Incidents
          </h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${data?.incidents?.length ?? 0} total`}
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
        data={data?.incidents ?? []}
        loading={loading}
        emptyComponent={<EmptyState icon={<AlertCircle size={32} />} title="Nessun incident trovato" description="Apri un nuovo incident o modifica i filtri applicati." />}
        onRowClick={(row) => navigate(`/incidents/${row.id}`)}
      />
    </div>
  )
}
