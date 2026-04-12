import { useState, useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { GET_INCIDENTS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { Pagination } from '@/components/ui/Pagination'

interface Incident {
  id:        string
  number:    string
  title:     string
  severity:  string
  status:    string
  createdAt: string
}

const PAGE_SIZE = 50

export function IncidentListPage() {
  const { t } = useTranslation()

  const columns: ColumnDef<Incident>[] = [
    { key: 'number',   label: 'Number',                                 width: '120px', sortable: true },
    { key: 'title',    label: t('pages.incidents.title_col'),    sortable: true },
    {
      key:     'severity',
      label:   t('pages.incidents.severity'),
      width:   '130px',
      sortable: true,
      render:  (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:     'status',
      label:   t('pages.incidents.status'),
      width:   '130px',
      sortable: true,
      render:  (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.incidents.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const filterFields = useEntityFields('Incident')
  const navigate = useNavigate()
  const location = useLocation()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data, loading, refetch } = useQuery<{
    incidents: { items: Incident[]; total: number }
  }>(GET_INCIDENTS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })

  const items = data?.incidents?.items ?? []
  const total = data?.incidents?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  useEffect(() => {
    if ((location.state as { refresh?: boolean } | null)?.refresh) {
      void refetch()
    }
  }, [location.state]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<AlertCircle size={22} color="#38bdf8" />}>
            {t('pages.incidents.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.incidents.count', { count: total })}
          </p>
        </div>
        <button
          onClick={() => navigate('/incidents/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {t('pages.incidents.new')}
        </button>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<Incident>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<AlertCircle size={32} />} title={t('pages.incidents.noResults')} description={t('pages.incidents.noResultsDesc')} />}
        onRowClick={(row) => navigate(`/incidents/${row.id}`)}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
      />

      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
    </PageContainer>
  )
}
