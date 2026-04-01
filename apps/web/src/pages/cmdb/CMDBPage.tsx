import { useState, useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { GET_ALL_CIS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

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
  useEffect(() => {
    setPage(0)
  }, [typeFromUrl])

  const { data, loading } = useQuery<{
    allCIs: { items: CI[]; total: number }
  }>(GET_ALL_CIS, {
    variables: {
      limit:   PAGE_SIZE,
      offset:  page * PAGE_SIZE,
      type:    typeFromUrl || undefined,
      filters: filterGroup ? JSON.stringify(filterGroup) : null,
    },
    fetchPolicy: 'cache-and-network',
  })

  const items = data?.allCIs?.items ?? []
  const total = data?.allCIs?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0 }}>
            {pageTitle}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.cmdb.count', { count: total })}
          </p>
        </div>
        <button
          disabled
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'not-allowed', opacity: 0.5 }}
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

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: "12px 0", fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} CI
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
    </div>
  )
}
