import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { CIIcon } from '@/lib/ciIcon'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

const PAGE_SIZE = 50

function toPascalCase(str: string): string {
  return str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function pluralize(str: string): string {
  if (str.endsWith('s')) return str + 'es'
  if (str.endsWith('y')) return str.slice(0, -1) + 'ies'
  return str + 's'
}

interface CIItem {
  id: string
  name: string
  type: string
  status: string | null
  environment: string | null
  createdAt: string
  ownerGroup: { id: string; name: string } | null
}

export function CIListPage() {
  const { typeName } = useParams<{ typeName: string }>()
  const navigate = useNavigate()
  const { getCIType, loading: metamodelLoading } = useMetamodel()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const ciType = typeName ? getCIType(typeName) : undefined

  const { queryKey, listQuery } = useMemo(() => {
    if (!typeName) return { queryKey: '', listQuery: null }
    const pascal = toPascalCase(typeName)
    const plural = pluralize(pascal)
    const key = plural.charAt(0).toLowerCase() + plural.slice(1)
    const query = gql`
      query DynamicList_${pascal}(
        $limit: Int, $offset: Int,
        $status: String, $environment: String, $search: String, $filters: String
      ) {
        ${key}(
          limit: $limit, offset: $offset,
          status: $status, environment: $environment, search: $search, filters: $filters
        ) {
          total
          items {
            id name type status environment createdAt
            ownerGroup { id name }
          }
        }
      }
    `
    return { queryKey: key, listQuery: query }
  }, [typeName])

  const { data, loading } = useQuery<Record<string, { total: number; items: CIItem[] }>>(
    listQuery ?? gql`query EmptyCIList { __typename }`,
    {
      variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null },
      fetchPolicy: 'cache-and-network',
      skip: !listQuery || !typeName,
    },
  )

  const result = queryKey ? data?.[queryKey] : undefined
  const items = result?.items ?? []
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const filterFields = useMemo((): FieldConfig[] => {
    if (!ciType) return []
    const base: FieldConfig[] = [
      { key: 'name',        label: 'Nome',           type: 'text' },
      { key: 'status',      label: 'Status',          type: 'enum', enumValues: ['active', 'inactive', 'maintenance'] },
      { key: 'environment', label: 'Environment',     type: 'enum', enumValues: ['production', 'staging', 'development'] },
      { key: 'ownerGroup',  label: 'Owner Group',     type: 'text' },
      { key: 'createdAt',   label: 'Creato il',       type: 'date' },
    ]
    const custom: FieldConfig[] = ciType.fields
      .filter((f) => !f.isSystem)
      .map((f) => ({
        key:        f.name,
        label:      f.label,
        type:       f.fieldType === 'date' ? 'date' : f.fieldType === 'enum' ? 'enum' : 'text',
        enumValues: f.enumValues?.length ? f.enumValues : undefined,
      } as FieldConfig))
    return [...base, ...custom]
  }, [ciType])

  const COLUMNS: ColumnDef<CIItem>[] = [
    { key: 'name', label: 'Nome', sortable: true },
    {
      key: 'environment', label: 'Env', sortable: true,
      render: (v) => v ? <EnvBadge environment={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span>,
    },
    {
      key: 'status', label: 'Status', sortable: true,
      render: (v) => v ? <StatusBadge value={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span>,
    },
    {
      key: 'ownerGroup', label: 'Owner Group', sortable: true,
      render: (v) => (v as CIItem['ownerGroup'])?.name ?? <span style={{ color: '#c4cad4' }}>—</span>,
    },
    {
      key: 'createdAt', label: 'Creato', sortable: true,
      render: (v) => new Date(v as string).toLocaleDateString('it-IT'),
    },
  ]

  if (metamodelLoading) {
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 14 }}>Caricamento metamodello…</div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 14 }}>Tipo CI "{typeName}" non trovato.</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CIIcon icon={ciType.icon} size={22} color={ciType.color} />
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{ciType.label}</h1>
          {total > 0 && <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{total} totali</span>}
        </div>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      {!loading && items.length === 0 ? (
        <EmptyState
          icon={<CIIcon icon={ciType.icon} size={32} color="var(--color-slate-light)" />}
          title={`Nessun ${ciType.label}`}
        />
      ) : (
        <SortableFilterTable
          columns={COLUMNS}
          data={items}
          loading={loading}
          onRowClick={(row) => navigate(`/ci/${typeName}/${row.id}`)}
        />
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 12, color: 'var(--color-slate)' }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page === 0 ? 'not-allowed' : 'pointer', opacity: page === 0 ? 0.4 : 1 }}
          >← Prev</button>
          <span>{page + 1} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1 }}
          >Next →</button>
        </div>
      )}
    </div>
  )
}
