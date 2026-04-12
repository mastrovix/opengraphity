import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { GitPullRequest } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { GET_CHANGES } from '@/graphql/queries'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { TypeBadge, PriorityBadge, StepBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'

interface WorkflowInstance { id: string; currentStep: string; status: string }
interface Team { id: string; name: string }
interface CI { id: string; name: string; type: string }

interface Change {
  id:               string
  number:           string
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

const PAGE_SIZE = 50

export function ChangeListPage() {
  const { t } = useTranslation()

  const columns: ColumnDef<Change>[] = [
    { key: 'number', label: 'Number', width: '120px', sortable: true },
    { key: 'title',  label: t('pages.changes.title_col'), sortable: true },
    {
      key:      'type',
      label:    t('pages.changes.type'),
      width:    '120px',
      sortable: true,
      render:   (v) => <TypeBadge type={String(v)} />,
    },
    {
      key:      'priority',
      label:    t('pages.changes.priority'),
      width:    '110px',
      sortable: true,
      render:   (v) => <PriorityBadge priority={String(v)} />,
    },
    {
      key:      'status',
      label:    t('pages.changes.step'),
      width:    '140px',
      sortable: true,
      render: (_v, row) => row.workflowInstance
        ? <StepBadge step={row.workflowInstance.currentStep} />
        : <span style={{ color: 'var(--color-slate-light)' }}>—</span>,
    },
    {
      key:      'assignedTeam' as keyof Change,
      label:    t('pages.changes.team'),
      width:    '140px',
      render:   (_v, row) => (
        <span style={{ color: "var(--color-slate)" }}>{(row as Change).assignedTeam?.name ?? '—'}</span>
      ),
    },
    {
      key:      'scheduledStart',
      label:    t('pages.changes.scheduledStart'),
      width:    '130px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)", whiteSpace: 'nowrap' }}>
          {v ? new Date(String(v)).toLocaleDateString() : '—'}
        </span>
      ),
    },
    {
      key:      'affectedCIs' as keyof Change,
      label:    t('pages.changes.ci'),
      width:    '70px',
      render:   (_v, row) => row.affectedCIs.length > 0 ? (
        <span style={{ color: "var(--color-slate)" }}>
          {row.affectedCIs.length} CI
        </span>
      ) : <span style={{ color: 'var(--color-slate-light)' }}>—</span>,
    },
    {
      key:      'createdAt',
      label:    t('pages.changes.createdAt'),
      width:    '110px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)", whiteSpace: 'nowrap' }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const filterFields = useEntityFields('Change')
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data, loading } = useQuery<{ changes: { items: Change[]; total: number } }>(GET_CHANGES, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })

  const items      = data?.changes?.items ?? []
  const total      = data?.changes?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<GitPullRequest size={22} color="var(--color-brand)" />}>
            {t('pages.changes.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.changes.count', { count: total })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => navigate('/changes/new')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
          >
            {t('pages.changes.new')}
          </button>
        </div>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<Change>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<GitPullRequest size={32} />} title={t('pages.changes.noResults')} description={t('pages.changes.noResultsDesc')} />}
        onRowClick={(row) => navigate(`/changes/${row.id}`)}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: "12px 0", fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.changes.count', { count: total })}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', border: "1px solid #e5e7eb", borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.prev')}
            </button>
            <span style={{ padding: '4px 8px', fontSize: 'var(--font-size-body)', color: "var(--color-slate)" }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', border: "1px solid #e5e7eb", borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
