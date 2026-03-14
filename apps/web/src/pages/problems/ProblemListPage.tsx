import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_PROBLEMS } from '@/graphql/queries'

interface Problem {
  id:        string
  title:     string
  status:    string
  impact:    string
  createdAt: string
}

const columns: ColumnDef<Problem>[] = [
  {
    key:         'title',
    label:       'Title',
    sortable:    true,
    filterable:  true,
    filterType:  'text',
  },
  {
    key:           'impact',
    label:         'Impact',
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
      { value: 'known_error', label: 'Known Error' },
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

export function ProblemListPage() {
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ problems: Problem[] }>(GET_PROBLEMS)

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
          Problems
        </h1>
        <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
          {loading ? '—' : `${data?.problems?.length ?? 0} total`}
        </p>
      </div>

      <SortableFilterTable<Problem>
        columns={columns}
        data={data?.problems ?? []}
        loading={loading}
        emptyMessage="Nessun problema trovato"
        onRowClick={(row) => navigate(`/problems/${row.id}`)}
      />
    </div>
  )
}
