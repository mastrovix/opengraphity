import { useState } from 'react'
import { useCustomFieldColumns, withCustomFieldCells } from '@/components/ticket/customFields/customFieldColumns'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Inbox, Plus } from 'lucide-react'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { TicketStatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { formatDate } from '@/lib/datetime'
import { Pagination } from '@/components/ui/Pagination'

interface ServiceRequest {
  customFields?: { name: string; value: string | null }[]
  id:        string
  number:    string
  title:     string
  priority:  string
  status:    string
  createdAt: string
}

const PAGE_SIZE = 50

export function RequestListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // Revisione totale · B-32/F-1: la lista era senza paginazione e l'API ne dava
  // 20; il contatore diceva «20 richieste» e le altre non si raggiungevano.
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const { fields: filterFields } = useEntityFields('ServiceRequest')

  // Campi del cliente (verifica «Cosa resta cablato», ondata 4): una colonna per campo.
  const customColumns = useCustomFieldColumns<ServiceRequest>('service_request')
  const baseColumns: ColumnDef<ServiceRequest>[] = [
    { key: 'number',   label: 'Number',                               width: '120px', sortable: true },
    { key: 'title',    label: t('pages.requests.title_col'), sortable: true },
    {
      key:      'priority',
      label:    t('pages.requests.priority'),
      width:    '130px',
      sortable: true,
      // F-5: vocabolario `priority`, non `severity`.
      render:   (v) => <SeverityBadge value={String(v)} vocabulary="priority" />,
    },
    {
      key:      'status',
      label:    t('pages.requests.status'),
      width:    '130px',
      sortable: true,
      render:   (v) => <TicketStatusBadge value={String(v)} entityType="service_request" />,
    },
    {
      key:      'createdAt',
      label:    t('pages.requests.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: 'var(--color-slate-light)' }}>
          {formatDate(String(v))}
        </span>
      ),
    },
  ]
  const columns = [...baseColumns, ...customColumns]


  const filtersJson = filterGroup ? JSON.stringify(filterGroup) : undefined

  const { data, loading, error, refetch } = useQuery<{ serviceRequests: { items: ServiceRequest[]; total: number } }>(GET_SERVICE_REQUESTS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filtersJson, sortField, sortDirection: sortDir },
    pollInterval: 30_000,   // keep the list fresh without manual reload
  })

  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction); setPage(0) }

  const items = data?.serviceRequests.items ?? []
  const total = data?.serviceRequests.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Inbox size={22} color="var(--color-icon-accent)" />}
        title={t('pages.requests.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.requests.count', { count: total })}
          </p>
        }
        actions={
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => navigate('/requests/new')}>
            {t('pages.requests.new')}
          </Button>
        }
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={filterFields}
            onApply={(group) => { setFilterGroup(group); setPage(0) }}
          />
        </div>
        <ExportCsvButton
          onExport={async () => { exportToCsv('service-requests', columns, withCustomFieldCells(items)) }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable<ServiceRequest>
            columns={columns}
            data={withCustomFieldCells(items)}
            loading={loading}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
            onRowClick={(row) => navigate(`/requests/${row.id}`)}
            emptyComponent={<EmptyState icon={<Inbox size={32} />} title={t('pages.requests.noResults')} description={t('pages.requests.noResultsDesc')} />}
          />

          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}
    </PageContainer>
  )
}
