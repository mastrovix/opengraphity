import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Bug } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { GET_PROBLEMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'

interface Problem {
  id:        string
  title:     string
  priority:  string
  status:    string
  createdAt: string
}

const PAGE_SIZE = 50

export function ProblemListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const columns: ColumnDef<Problem>[] = [
    { key: 'title',    label: t('pages.problems.title_col'), sortable: true },
    {
      key:     'priority',
      label:   t('pages.problems.priority'),
      width:   '130px',
      sortable: true,
      render:  (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:     'status',
      label:   t('pages.problems.status'),
      width:   '130px',
      sortable: true,
      render:  (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.problems.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const filterFields = useEntityFields('Problem')
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data, loading } = useQuery<{ problems: { items: Problem[]; total: number } }>(GET_PROBLEMS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })

  const items      = data?.problems?.items ?? []
  const total      = data?.problems?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Bug size={22} color="var(--color-brand)" />}>
            {t('pages.problems.title')}
          </PageTitle>
          <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.problems.count', { count: total })}
          </p>
        </div>
        <button
          onClick={() => navigate('/problems/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {t('pages.problems.new')}
        </button>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<Problem>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<Bug size={32} />} title={t('pages.problems.noResults')} description={t('pages.problems.noResultsDesc')} />}
        onRowClick={(row) => navigate(`/problems/${row.id}`)}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
      />

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: "12px 0", fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.problems.count', { count: total })}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.prev')}
            </button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: "var(--color-slate)" }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
