import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { GitPullRequest } from 'lucide-react'
import { GET_CHANGES } from '@/graphql/queries'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { TypeBadge, PriorityBadge, StepBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'

interface WorkflowInstance { id: string; currentStep: string; status: string }
interface Team { id: string; name: string }
interface CI { id: string; name: string; type: string }

interface Change {
  id:               string
  title:            string
  type:             string
  priority:         string
  status:           string
  scheduledStart:   string | null
  scheduledEnd:     string | null
  createdAt:        string
  assignedTeam:     Team | null
  affectedCIs:      CI[]
  workflowInstance: WorkflowInstance | null
}

const columns: ColumnDef<Change>[] = [
  {
    key:        'title',
    label:      'Titolo',
    sortable:   true,
    filterable: true,
    filterType: 'text',
    render: (v, row) => (
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', marginBottom: 2 }}>{String(v)}</div>
        <div style={{ fontSize: 11, color: '#8892a4', fontFamily: 'monospace' }}>{row.id.slice(0, 8)}</div>
      </div>
    ),
  },
  {
    key:           'type',
    label:         'Tipo',
    width:         '120px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'standard',  label: 'Standard' },
      { value: 'normal',    label: 'Normal' },
      { value: 'emergency', label: 'Emergency' },
    ],
    render: (v) => <TypeBadge type={String(v)} />,
  },
  {
    key:           'priority',
    label:         'Priorità',
    width:         '110px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'low',      label: 'Low' },
      { value: 'medium',   label: 'Medium' },
      { value: 'high',     label: 'High' },
      { value: 'critical', label: 'Critical' },
    ],
    render: (v) => <PriorityBadge priority={String(v)} />,
  },
  {
    key:           'status',
    label:         'Step',
    width:         '140px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'draft',        label: 'Draft' },
      { value: 'assessment',   label: 'Assessment' },
      { value: 'cab_approval', label: 'CAB Approval' },
      { value: 'scheduled',    label: 'Scheduled' },
      { value: 'validation',   label: 'Validation' },
      { value: 'deployment',   label: 'Deployment' },
      { value: 'completed',    label: 'Completed' },
      { value: 'failed',       label: 'Failed' },
      { value: 'rejected',     label: 'Rejected' },
    ],
    render: (_v, row) => row.workflowInstance
      ? <StepBadge step={row.workflowInstance.currentStep} />
      : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>,
  },
  {
    key:      'assignedTeam' as keyof Change,
    label:    'Team',
    width:    '140px',
    render:   (_v, row) => (
      <span style={{ fontSize: 13, color: '#4a5468' }}>{(row as Change).assignedTeam?.name ?? '—'}</span>
    ),
  },
  {
    key:      'scheduledStart',
    label:    'Scheduled Start',
    width:    '130px',
    sortable: true,
    render:   (v) => (
      <span style={{ fontSize: 12, color: '#8892a4', whiteSpace: 'nowrap' }}>
        {v ? new Date(String(v)).toLocaleDateString('it-IT') : '—'}
      </span>
    ),
  },
  {
    key:      'affectedCIs' as keyof Change,
    label:    'CI',
    width:    '70px',
    render:   (_v, row) => row.affectedCIs.length > 0 ? (
      <span style={{ backgroundColor: '#eff6ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600 }}>
        {row.affectedCIs.length} CI
      </span>
    ) : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>,
  },
  {
    key:      'createdAt',
    label:    'Creato',
    width:    '110px',
    sortable: true,
    render:   (v) => (
      <span style={{ fontSize: 12, color: '#8892a4', whiteSpace: 'nowrap' }}>
        {new Date(String(v)).toLocaleDateString('it-IT')}
      </span>
    ),
  },
]

const PAGE_SIZE = 50

export function ChangeListPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [queryFilters, setQueryFilters] = useState<Record<string, string>>({})

  const { data, loading } = useQuery<{ changes: { items: Change[]; total: number } }>(GET_CHANGES, {
    variables: {
      limit:    PAGE_SIZE,
      offset:   page * PAGE_SIZE,
      type:     queryFilters['type']     || undefined,
      priority: queryFilters['priority'] || undefined,
      status:   queryFilters['status']   || undefined,
      search:   queryFilters['title']    || undefined,
    },
    fetchPolicy: 'cache-and-network',
  })

  const items      = data?.changes?.items ?? []
  const total      = data?.changes?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const handleFiltersChange = (filters: Record<string, string>) => {
    setQueryFilters(filters)
    setPage(0)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>Changes</h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} change${total !== 1 ? 's' : ''}`}
          </p>
        </div>
        <button
          onClick={() => navigate('/changes/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          Nuovo Change
        </button>
      </div>

      <SortableFilterTable<Change>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<GitPullRequest size={32} />} title="Nessun change trovato" description="Crea il primo change o modifica i filtri applicati." />}
        onRowClick={(row) => navigate(`/changes/${row.id}`)}
        onFiltersChange={handleFiltersChange}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 13, color: '#8892a4' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} di {total} changes
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
