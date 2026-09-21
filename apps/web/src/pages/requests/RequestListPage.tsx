import { useState } from 'react'
import { pausedWhenHidden } from '@/lib/polling'
import { useCustomFieldColumns, withCustomFieldCells } from '@/components/ticket/customFields/customFieldColumns'
import { useFormFieldColumns, type FormFieldValue } from '@/components/ticket/formFieldColumns'
import { useApolloClient, useQuery } from '@apollo/client/react'
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
  formFieldValues?: FormFieldValue[]
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
  // Le colonne dei campi della libreria dei moduli (ondata 4): stesso stampo,
  // insieme diverso — questi vengono dai moduli del catalogo.
  const { columns: formColumns, withCells: withFormFieldCells } = useFormFieldColumns<ServiceRequest>()
  const baseColumns: ColumnDef<ServiceRequest>[] = [
    // Intestazione TRADOTTA (revisione totale · i 29 warning): era la stringa
    // inglese «Number» scritta nel codice, in mezzo a colonne che passano da
    // i18n — e nessun guardiano poteva vederla, perché per quella colonna una
    // chiave non era mai stata scritta.
    { key: 'number',   label: t('common.number'),                               width: '120px', sortable: true },
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
  const columns = [...baseColumns, ...customColumns, ...formColumns]


  const filtersJson = filterGroup ? JSON.stringify(filterGroup) : undefined

  const apollo = useApolloClient()
  const { data, loading, error, refetch } = useQuery<{ serviceRequests: { items: ServiceRequest[]; total: number } }>(GET_SERVICE_REQUESTS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filtersJson, sortField, sortDirection: sortDir },
    // F-21: il polling si ferma quando la scheda è in background.
    ...pausedWhenHidden(30_000),
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
          onExport={async () => {
            /*
             * IL CSV ESPORTA TUTTE LE RIGHE FILTRATE, non la pagina a schermo
             * (revisione del 17 set 2026). Prima passava `items`, cioè le venti
             * righe correnti: con 350 richieste filtrate si otteneva un file da
             * venti righe, col nome giusto e nessun avviso — ed è la lista dove
             * vivono le risposte ai moduli. Incident, problem e CI rifanno la
             * query da sempre; le richieste no.
             */
            const res = await apollo.query<{ serviceRequests: { items: ServiceRequest[] } }>({
              query: GET_SERVICE_REQUESTS,
              variables: { limit: 10000, offset: 0, filters: filtersJson, sortField, sortDirection: sortDir },
              fetchPolicy: 'network-only',
            })
            exportToCsv('service-requests', columns, withFormFieldCells(withCustomFieldCells(res.data?.serviceRequests?.items ?? [])))
          }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable<ServiceRequest>
            columns={columns}
            data={withFormFieldCells(withCustomFieldCells(items))}
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
