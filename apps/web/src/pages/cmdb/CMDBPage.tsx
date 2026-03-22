import { useState, useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Server } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { GET_ALL_CIS } from '@/graphql/queries'

interface CI {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
  createdAt:   string
}

const TYPE_OPTIONS = [
  { value: 'server',           label: 'Server' },
  { value: 'virtual_machine',  label: 'Virtual Machine' },
  { value: 'database',         label: 'Database' },
  { value: 'database_instance',label: 'DB Instance' },
  { value: 'application',      label: 'Application' },
  { value: 'microservice',     label: 'Microservice' },
  { value: 'network_device',   label: 'Network Device' },
  { value: 'storage',          label: 'Storage' },
  { value: 'cloud_service',    label: 'Cloud Service' },
  { value: 'ssl_certificate',  label: 'SSL Certificate' },
  { value: 'api_endpoint',     label: 'API Endpoint' },
]

const columns: ColumnDef<CI>[] = [
  {
    key:        'name',
    label:      'Name',
    sortable:   true,
    filterable: true,
    filterType: 'text',
  },
  {
    key:           'type',
    label:         'Type',
    width:         '160px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: TYPE_OPTIONS,
    render: (v) => (
      <span style={{ color: "#64748b", textTransform: 'capitalize' }}>
        {String(v).replace(/_/g, ' ')}
      </span>
    ),
  },
  {
    key:           'status',
    label:         'Status',
    width:         '130px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'active',         label: 'Active' },
      { value: 'inactive',       label: 'Inactive' },
      { value: 'maintenance',    label: 'Maintenance' },
      { value: 'decommissioned', label: 'Decommissioned' },
    ],
    render: (v) => <StatusBadge value={String(v)} />,
  },
  {
    key:           'environment',
    label:         'Environment',
    width:         '140px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'production',  label: 'Production' },
      { value: 'staging',     label: 'Staging' },
      { value: 'development', label: 'Development' },
      { value: 'dr',          label: 'DR' },
    ],
    render: (v) => <EnvBadge environment={String(v)} />,
  },
  {
    key:      'createdAt',
    label:    'Created',
    width:    '120px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: "#94a3b8" }}>
        {new Date(String(v)).toLocaleDateString()}
      </span>
    ),
  },
]

const PAGE_SIZE = 50

export function CMDBPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const typeFromUrl = searchParams.get('type')

  const pageTitle = typeFromUrl
    ? typeFromUrl.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'CMDB'

  const [page, setPage] = useState(0)
  const [queryFilters, setQueryFilters] = useState<Record<string, string>>(
    typeFromUrl ? { type: typeFromUrl } : {}
  )

  useEffect(() => {
    setQueryFilters(typeFromUrl ? { type: typeFromUrl } : {})
    setPage(0)
  }, [typeFromUrl])

  const { data, loading } = useQuery<{
    allCIs: { items: CI[]; total: number }
  }>(GET_ALL_CIS, {
    variables: {
      limit:       PAGE_SIZE,
      offset:      page * PAGE_SIZE,
      type:        queryFilters['type']        || undefined,
      environment: queryFilters['environment'] || undefined,
      status:      queryFilters['status']      || undefined,
      search:      queryFilters['name']        || undefined,
    },
  })

  const items = data?.allCIs?.items ?? []
  const total = data?.allCIs?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const handleFiltersChange = (filters: Record<string, string>) => {
    setQueryFilters(filters)
    setPage(0)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: '#0f172a', letterSpacing: '-0.01em', margin: 0 }}>
            {pageTitle}
          </h1>
          <p style={{ fontSize: 14, color: '#94a3b8', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} configuration items`}
          </p>
        </div>
        <button
          disabled
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#0284c7', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'not-allowed', opacity: 0.6 }}
        >
          New
        </button>
      </div>

      <SortableFilterTable<CI>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<Server size={32} />} title="Nessun configuration item trovato" description="Il CMDB è vuoto. Aggiungi il primo CI per iniziare." />}
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
        onFiltersChange={handleFiltersChange}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: "12px 0", fontSize: 12, color: '#94a3b8' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} di {total} CI
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : '#64748b', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              ← Prev
            </button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: "#64748b" }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : '#64748b', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
