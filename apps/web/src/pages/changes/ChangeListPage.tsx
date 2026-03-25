import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { GitPullRequest } from 'lucide-react'
import { GET_CHANGES } from '@/graphql/queries'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { TypeBadge, PriorityBadge, StepBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

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
    key:      'title',
    label:    'Titolo',
    sortable: true,
    render: (v, row) => (
      <div>
        <div style={{ fontWeight: 600, color: "var(--color-slate-dark)", marginBottom: 2 }}>{String(v)}</div>
        <div style={{ color: 'var(--color-slate-light)' }}>{row.id.slice(0, 8)}</div>
      </div>
    ),
  },
  {
    key:      'type',
    label:    'Tipo',
    width:    '120px',
    sortable: true,
    render:   (v) => <TypeBadge type={String(v)} />,
  },
  {
    key:      'priority',
    label:    'Priorità',
    width:    '110px',
    sortable: true,
    render:   (v) => <PriorityBadge priority={String(v)} />,
  },
  {
    key:      'status',
    label:    'Step',
    width:    '140px',
    sortable: true,
    render: (_v, row) => row.workflowInstance
      ? <StepBadge step={row.workflowInstance.currentStep} />
      : <span style={{ color: 'var(--color-slate-light)' }}>—</span>,
  },
  {
    key:      'assignedTeam' as keyof Change,
    label:    'Team',
    width:    '140px',
    render:   (_v, row) => (
      <span style={{ color: "var(--color-slate)" }}>{(row as Change).assignedTeam?.name ?? '—'}</span>
    ),
  },
  {
    key:      'scheduledStart',
    label:    'Scheduled Start',
    width:    '130px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: "var(--color-slate-light)", whiteSpace: 'nowrap' }}>
        {v ? new Date(String(v)).toLocaleDateString('it-IT') : '—'}
      </span>
    ),
  },
  {
    key:      'affectedCIs' as keyof Change,
    label:    'CI',
    width:    '70px',
    render:   (_v, row) => row.affectedCIs.length > 0 ? (
      <span style={{ color: "var(--color-slate)" }}>
        {row.affectedCIs.length} CI
      </span>
    ) : <span style={{ color: 'var(--color-slate-light)' }}>—</span>,
  },
  {
    key:      'createdAt',
    label:    'Creato',
    width:    '110px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: "var(--color-slate-light)", whiteSpace: 'nowrap' }}>
        {new Date(String(v)).toLocaleDateString('it-IT')}
      </span>
    ),
  },
]

const PAGE_SIZE = 50

const FILTER_FIELDS: FieldConfig[] = [
  { key: 'title',        label: 'Titolo',          type: 'text' },
  { key: 'type',         label: 'Tipo',            type: 'enum', enumValues: ['standard', 'normal', 'emergency'] },
  { key: 'priority',     label: 'Priorità',        type: 'enum', enumValues: ['critical', 'high', 'medium', 'low'] },
  { key: 'status',       label: 'Status',          type: 'text' },
  { key: 'assignedTeam', label: 'Team',            type: 'text' },
  { key: 'scheduledStart', label: 'Scheduled Start', type: 'date' },
  { key: 'createdAt',    label: 'Creato il',       type: 'date' },
]

export function ChangeListPage() {
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const { data, loading } = useQuery<{ changes: { items: Change[]; total: number } }>(GET_CHANGES, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null },
    fetchPolicy: 'cache-and-network',
  })

  const items      = data?.changes?.items ?? []
  const total      = data?.changes?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>Changes</h1>
          <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} change${total !== 1 ? 's' : ''}`}
          </p>
        </div>
        <button
          onClick={() => navigate('/changes/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: 'var(--color-brand)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
          Nuovo Change
        </button>
      </div>

      <FilterBuilder
        fields={FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<Change>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<GitPullRequest size={32} />} title="Nessun change trovato" description="Crea il primo change o modifica i filtri applicati." />}
        onRowClick={(row) => navigate(`/changes/${row.id}`)}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: "12px 0", fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} di {total} changes
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              ← Prev
            </button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: "var(--color-slate)" }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
