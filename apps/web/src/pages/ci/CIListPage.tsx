import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { toast } from 'sonner'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { CIIcon } from '@/lib/ciIcon'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { CIDynamicForm } from '@/components/CIDynamicForm'

import { toPascalCase, pluralize } from '@/lib/stringUtils'

const PAGE_SIZE = 50

interface CIItem {
  id: string
  name: string
  type: string
  status: string | null
  environment: string | null
  createdAt: string
  ownerGroup: { id: string; name: string } | null
}

const CI_TYPE_KEYS: Record<string, string> = {
  application:       'sidebar.application',
  server:            'sidebar.server',
  database:          'sidebar.database',
  database_instance: 'sidebar.dbInstance',
  certificate:       'sidebar.certificate',
  ssl_certificate:   'sidebar.certificate',
}

export function CIListPage() {
  const { t, i18n } = useTranslation()
  const { typeName } = useParams<{ typeName: string }>()
  const navigate = useNavigate()
  const { getCIType, loading: metamodelLoading } = useMetamodel()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const ciType = typeName ? getCIType(typeName) : undefined
  const ciTypeLabel = (typeName && CI_TYPE_KEYS[typeName]) ? t(CI_TYPE_KEYS[typeName]) : (ciType?.label ?? '')
  const newLabel = i18n.language.startsWith('it') && ciTypeLabel.match(/[aA]$/)
    ? t('pages.cmdb.newFeminine', { type: ciTypeLabel })
    : t('pages.cmdb.new', { type: ciTypeLabel })

  const { queryKey, listQuery, createMutation } = useMemo(() => {
    if (!typeName) return { queryKey: '', listQuery: null, createMutation: null }
    const pascal = toPascalCase(typeName)
    const plural = pluralize(pascal)
    const key = plural.charAt(0).toLowerCase() + plural.slice(1)
    const query = gql`
      query DynamicList_${pascal}(
        $limit: Int, $offset: Int,
        $status: String, $environment: String, $search: String, $filters: String,
        $sortField: String, $sortDirection: String
      ) {
        ${key}(
          limit: $limit, offset: $offset,
          status: $status, environment: $environment, search: $search, filters: $filters,
          sortField: $sortField, sortDirection: $sortDirection
        ) {
          total
          items {
            id name type status environment createdAt
            ownerGroup { id name }
          }
        }
      }
    `
    const mutation = gql`
      mutation DynamicCreate_${pascal}($input: Create${pascal}Input!) {
        create${pascal}(input: $input) { id name }
      }
    `
    return { queryKey: key, listQuery: query, createMutation: mutation }
  }, [typeName])

  const { data, loading, refetch } = useQuery<Record<string, { total: number; items: CIItem[] }>>(
    listQuery ?? gql`query EmptyCIList { __typename }`,
    {
      variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
      fetchPolicy: 'cache-and-network',
      skip: !listQuery || !typeName,
    },
  )

  const [createCI, { loading: creating }] = useMutation<Record<string, { id: string; name: string }>>(
    createMutation ?? gql`mutation EmptyCICreate { __typename }`,
    {
      onCompleted: (res) => {
        const key = `create${toPascalCase(typeName ?? '')}`
        const newId = res[key]?.id
        toast.success(t('pages.cmdb.ciCreated', { type: ciTypeLabel || 'CI' }))
        setShowCreate(false)
        void refetch()
        if (newId) navigate(`/ci/${typeName}/${newId}`)
      },
      onError: (err) => toast.error(err.message),
    },
  )

  const result = queryKey ? data?.[queryKey] : undefined
  const items = result?.items ?? []
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const filterFields = useMemo((): FieldConfig[] => {
    if (!ciType) return []
    const base: FieldConfig[] = [
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
      { key: 'ownerGroup',  label: t('pages.cmdb.ownerGroup'),  type: 'text' },
      { key: 'createdAt',   label: t('pages.cmdb.createdAt'),   type: 'date' },
    ]
    const custom: FieldConfig[] = ciType.fields
      .filter((f) => !f.isSystem)
      .map((f) => ({
        key:     f.name,
        label:   f.label,
        type:    f.fieldType === 'date' ? 'date' : f.fieldType === 'enum' ? 'enum' : 'text',
        options: f.enumValues?.length
          ? f.enumValues.map((v: string) => ({
              value: v,
              label: v.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
            }))
          : undefined,
      } as FieldConfig))
    return [...base, ...custom]
  }, [ciType])

  const COLUMNS: ColumnDef<CIItem>[] = [
    { key: 'name', label: t('pages.cmdb.name'), sortable: true },
    {
      key: 'environment', label: t('pages.cmdb.environment'), sortable: true,
      render: (v) => v ? <EnvBadge environment={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span>,
    },
    {
      key: 'status', label: t('pages.cmdb.status'), sortable: true,
      render: (v) => v ? <StatusBadge value={v as string} /> : <span style={{ color: '#c4cad4' }}>—</span>,
    },
    {
      key: 'ownerGroup', label: t('pages.cmdb.ownerGroup'), sortable: true,
      render: (v) => (v as CIItem['ownerGroup'])?.name ?? <span style={{ color: '#c4cad4' }}>—</span>,
    },
    {
      key: 'createdAt', label: t('pages.cmdb.createdAt'), sortable: true,
      render: (v) => new Date(v as string).toLocaleDateString(),
    },
  ]

  if (metamodelLoading) {
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 14 }}>{t('common.loading')}</div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 14 }}>{t('pages.cmdb.notFound', { type: typeName })}</div>
  }


  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <CIIcon icon={ciType.icon} size={22} color={ciType.color} />
            {ciTypeLabel}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} ${ciTypeLabel.toLowerCase()}`}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {newLabel}
        </button>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      {!loading && items.length === 0 ? (
        <EmptyState
          icon={<CIIcon icon={ciType.icon} size={32} color="var(--color-slate-light)" />}
          title={t('pages.cmdb.noCiOfType', { type: ciTypeLabel })}
        />
      ) : (
        <SortableFilterTable
          columns={COLUMNS}
          data={items}
          loading={loading}
          onRowClick={(row) => navigate(`/ci/${typeName}/${row.id}`)}
          onSort={handleSort}
          sortField={sortField}
          sortDir={sortDir}
        />
      )}

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {ciTypeLabel.toLowerCase()}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >{t('common.prev')}</button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: 'var(--color-slate)' }}>{page + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >{t('common.next')}</button>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false) }}
        >
          <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 28, width: 520, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 20px 0' }}>
              {newLabel}
            </h2>
            <CIDynamicForm
              ciType={ciType}
              loading={creating}
              onCancel={() => setShowCreate(false)}
              onSubmit={async (values) => {
                await createCI({ variables: { input: values } })
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
