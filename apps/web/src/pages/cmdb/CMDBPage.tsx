import { useState, useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { GET_ALL_CIS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'

interface CI {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
  createdAt:   string
}


const PAGE_SIZE = 50

export function CMDBPage() {
  const { t } = useTranslation()

  const columns: ColumnDef<CI>[] = [
    { key: 'name', label: t('pages.cmdb.name'), sortable: true },
    {
      key:      'type',
      label:    t('pages.cmdb.type'),
      width:    '160px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate)", textTransform: 'capitalize' }}>
          {String(v).replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key:      'status',
      label:    t('pages.cmdb.status'),
      width:    '130px',
      sortable: true,
      render:   (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'environment',
      label:    t('pages.cmdb.environment'),
      width:    '140px',
      sortable: true,
      render:   (v) => <EnvBadge environment={String(v)} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.cmdb.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',        label: t('pages.cmdb.name'),        type: 'text' },
    { key: 'status',      label: t('pages.cmdb.status'),      type: 'enum', options: [
      { value: 'active',      label: 'Active'      },
      { value: 'inactive',    label: 'Inactive'    },
      { value: 'maintenance', label: 'Maintenance' },
    ]},
    { key: 'environment', label: t('pages.cmdb.environment'), type: 'enum', options: [
      { value: 'production',  label: 'Production'  },
      { value: 'staging',     label: 'Staging'     },
      { value: 'development', label: 'Development' },
    ]},
    { key: 'createdAt',   label: t('pages.cmdb.createdAt'),   type: 'date' },
  ]
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const typeFromUrl = searchParams.get('type')

  const pageTitle = typeFromUrl
    ? typeFromUrl.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'CMDB'

  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  useEffect(() => {
    setPage(0)
  }, [typeFromUrl])

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data, loading } = useQuery<{
    allCIs: { items: CI[]; total: number }
  }>(GET_ALL_CIS, {
    variables: {
      limit:         PAGE_SIZE,
      offset:        page * PAGE_SIZE,
      type:          typeFromUrl || undefined,
      filters:       filterGroup ? JSON.stringify(filterGroup) : null,
      sortField,
      sortDirection: sortDir,
    },
    fetchPolicy: 'cache-and-network',
  })

  const items = data?.allCIs?.items ?? []
  const total = data?.allCIs?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Server size={22} color="#38bdf8" />}>
            {pageTitle}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.cmdb.count', { count: total })}
          </p>
        </div>
        <button
          disabled
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'not-allowed', opacity: 0.5 }}
        >
          {t('common.create')}
        </button>
      </div>

      <FilterBuilder
        fields={FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<CI>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<Server size={32} />} title={t('pages.cmdb.noResults')} description={t('pages.cmdb.noResultsDesc')} />}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
        onRowClick={(row) => {
          switch (row.type) {
            case 'application':       navigate(`/applications/${row.id}`);       break
            case 'database':          navigate(`/databases/${row.id}`);          break
            case 'database_instance': navigate(`/database-instances/${row.id}`); break
            case 'server':            navigate(`/servers/${row.id}`);            break
            case 'certificate':       navigate(`/certificates/${row.id}`);       break
            default:                  navigate(`/cmdb/${row.id}`)
          }
        }}
      />

      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
    </PageContainer>
  )
}
