import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'

interface ServiceRequest {
  id:        string
  number:    string
  title:     string
  priority:  string
  status:    string
  createdAt: string
}

export function RequestListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const filterFields = useEntityFields('ServiceRequest')

  const columns: ColumnDef<ServiceRequest>[] = [
    { key: 'number',   label: 'Number',                               width: '120px', sortable: true },
    { key: 'title',    label: t('pages.requests.title_col'), sortable: true },
    {
      key:      'priority',
      label:    t('pages.requests.priority'),
      width:    '130px',
      sortable: true,
      render:   (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:      'status',
      label:    t('pages.requests.status'),
      width:    '130px',
      sortable: true,
      render:   (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.requests.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: 'var(--color-slate-light)' }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const filtersJson = filterGroup ? JSON.stringify(filterGroup) : undefined

  const { data, loading } = useQuery<{ serviceRequests: ServiceRequest[] }>(GET_SERVICE_REQUESTS, {
    variables: { filters: filtersJson, sortField, sortDirection: sortDir },
  })

  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction) }

  const items = data?.serviceRequests ?? []

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Inbox size={22} color="#38bdf8" />}>
            {t('pages.requests.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.requests.count', { count: items.length })}
          </p>
        </div>
        <button
          onClick={() => navigate('/requests/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {t('pages.requests.new')}
        </button>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group) }}
      />

      <SortableFilterTable<ServiceRequest>
        columns={columns}
        data={items}
        loading={loading}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
        onRowClick={(row) => navigate(`/requests/${row.id}`)}
        emptyComponent={<EmptyState icon={<Inbox size={32} />} title={t('pages.requests.noResults')} description={t('pages.requests.noResultsDesc')} />}
      />
    </PageContainer>
  )
}
