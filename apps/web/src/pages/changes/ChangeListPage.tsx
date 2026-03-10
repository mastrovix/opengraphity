import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_CHANGES } from '@/graphql/queries'

interface Change {
  id:           string
  title:        string
  type:         string
  risk:         string
  status:       string
  windowStart?: string
}

const columns: ColumnDef<Change>[] = [
  {
    key:         'title',
    label:       'Title',
    sortable:    true,
    filterable:  true,
    filterType:  'text',
  },
  {
    key:           'type',
    label:         'Type',
    width:         '120px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'standard',  label: 'Standard' },
      { value: 'normal',    label: 'Normal' },
      { value: 'emergency', label: 'Emergency' },
    ],
    render: (v) => (
      <span style={{ fontSize: 13, color: '#4a5468', textTransform: 'capitalize' }}>{String(v)}</span>
    ),
  },
  {
    key:           'risk',
    label:         'Risk',
    width:         '110px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'low',    label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high',   label: 'High' },
    ],
    render: (v) => <SeverityBadge value={String(v)} />,
  },
  {
    key:           'status',
    label:         'Status',
    width:         '160px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'pending_approval', label: 'Pending Approval' },
      { value: 'approved',         label: 'Approved' },
      { value: 'deployed',         label: 'Deployed' },
      { value: 'rejected',         label: 'Rejected' },
      { value: 'failed',           label: 'Failed' },
    ],
    render: (v) => <StatusBadge value={String(v)} />,
  },
  {
    key:      'windowStart',
    label:    'Window Start',
    width:    '130px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: '#8892a4', fontSize: 13 }}>
        {v ? new Date(String(v)).toLocaleDateString() : '—'}
      </span>
    ),
  },
]

export function ChangeListPage() {
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ changes: Change[] }>(GET_CHANGES)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            Changes
          </h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${data?.changes?.length ?? 0} total`}
          </p>
        </div>
        <button
          onClick={() => navigate('/changes/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          New Change
        </button>
      </div>

      <SortableFilterTable<Change>
        columns={columns}
        data={data?.changes ?? []}
        loading={loading}
        emptyMessage="No changes found"
      />
    </div>
  )
}
