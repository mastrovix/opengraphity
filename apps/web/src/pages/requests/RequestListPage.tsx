import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'

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

  const { data, loading, error, refetch } = useQuery<{ serviceRequests: ServiceRequest[] }>(GET_SERVICE_REQUESTS, {
    variables: { filters: filtersJson, sortField, sortDirection: sortDir },
    pollInterval: 30_000,   // keep the list fresh without manual reload
  })

  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction) }

  const items = data?.serviceRequests ?? []

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Inbox size={22} color="var(--color-icon-accent)" />}
        title={t('pages.requests.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.requests.count', { count: items.length })}
          </p>
        }
        actions={
          <Button onClick={() => navigate('/requests/new')}>
            {t('pages.requests.new')}
          </Button>
        }
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={filterFields}
            onApply={(group) => { setFilterGroup(group) }}
          />
        </div>
        <ExportCsvButton
          onExport={async () => { exportToCsv('service-requests', columns, items) }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
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
        </>
      )}
    </PageContainer>
  )
}
