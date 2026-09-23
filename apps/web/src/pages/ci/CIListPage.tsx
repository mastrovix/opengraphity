import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { toast } from 'sonner'
import { useMetamodel, type CITypeDef } from '@/contexts/MetamodelContext'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { StatusBadge } from '@/components/StatusBadge'
import { EnvBadge } from '@/components/Badges'
import { EmptyState } from '@/components/EmptyState'
import { CIIcon } from '@/lib/ciIcon'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { apolloClient } from '@/lib/apollo'

import { toPascalCase, pluralize } from '@/lib/stringUtils'
import { formatDate } from '@/lib/datetime'
import { toEnumOptions, useCIBaseEnums } from '@/lib/ciEnums'
import { useCILabels, CI_STATUS_VOCABULARY, CI_ENVIRONMENT_VOCABULARY } from '@/hooks/useCILabels'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { TFunction } from 'i18next'
import { palette } from '@/lib/tokens'
import { Plus } from 'lucide-react'
import { showError } from '@/lib/showError'

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

/**
 * The fields the filter builder offers on a CI type. A vocabulary value reads
 * with its Dictionary label, or humanized by the one shared rule when it has
 * none (D29): «in_progress» → «In progress», a sentence stays as it is. This
 * list used its own copy of the rule, which capitalised every word.
 */
function ciFilterFields(
  ciType: CITypeDef, t: TFunction, baseEnums: { statuses: string[]; environments: string[] },
  labelOf: (vocabulary: string, value: string) => string | null,
): FieldConfig[] {
  const base: FieldConfig[] = [
    { key: 'name',        label: t('pages.cmdb.name'),        type: 'text' },
    { key: 'status',      label: t('pages.cmdb.status'),      type: 'enum', options: toEnumOptions(baseEnums.statuses, (v) => labelOf(CI_STATUS_VOCABULARY, v)) },
    { key: 'environment', label: t('pages.cmdb.environment'), type: 'enum', options: toEnumOptions(baseEnums.environments, (v) => labelOf(CI_ENVIRONMENT_VOCABULARY, v)) },
    { key: 'ownerGroup',  label: t('pages.cmdb.ownerGroup'),  type: 'text' },
    { key: 'chain',       label: t('ciTypeDesigner.chain'),    type: 'enum', options: [
      { value: 'Application',    label: t('ciTypeDesigner.chainApplication')    },
      { value: 'Infrastructure', label: t('ciTypeDesigner.chainInfrastructure') },
    ]},
    { key: 'createdAt',   label: t('pages.cmdb.createdAt'),   type: 'date' },
  ]
  const custom: FieldConfig[] = ciType.fields
    .filter((f) => !f.isSystem)
    .map((f) => ({
      key:     f.name,
      label:   f.label,
      type:    f.fieldType === 'date' ? 'date' : f.fieldType === 'enum' ? 'enum' : 'text',
      options: f.enumValues?.length
        ? toEnumOptions(f.enumValues, (v) => (f.enumTypeName ? labelOf(f.enumTypeName, v) : null))
        : undefined,
    } as FieldConfig))
  return [...base, ...custom]
}

export function CIListPage() {
  const { t } = useTranslation()
  const { typeName } = useParams<{ typeName: string }>()
  const navigate = useNavigate()
  const { getCIType, loading: metamodelLoading, error: metamodelError } = useMetamodel()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { typeLabel } = useCILabels()
  const { labelOf } = useDomainVocabularies()
  const ciType = typeName ? getCIType(typeName) : undefined
  // F-22 (l'etichetta del disegnatore vince sulla chiave i18n) vive in
  // `useCILabels`, che la applica anche alle anomalie e alla mappa dei
  // servizi: qui era una terza copia della stessa regola.
  const ciTypeLabel = typeName ? typeLabel(typeName) : ''
  const baseEnums = useCIBaseEnums()
  /**
   * NESSUNA euristica di genere (revisione totale · F-44): «finisce per A
   * quindi è femminile» sbaglia su qualunque tipo del cliente — «Stampante»
   * diventava «Nuovo Stampante», «Sonda» ci prendeva per caso. Il testo ora
   * non concorda: «Aggiungi: <tipo>» vale per ogni nome, in ogni lingua, e
   * non inventa una grammatica sui nomi che il cliente sceglie.
   */
  const newLabel = t('pages.cmdb.addOfType', { type: ciTypeLabel })

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

  // Only a type the metamodel has is asked for (tour of 23 Sep 2026): the
  // query is named after the type, and for `/ci/firewall` the schema has no
  // `firewalls`: the server refused it and a technical toast stood next to the
  // page's own «not found». While the metamodel loads, or when it failed, the
  // type is not known yet: the list waits, and the page says which case it is.
  const { data, loading, error, refetch } = useQuery<Record<string, { total: number; items: CIItem[] }>>(
    listQuery ?? gql`query EmptyCIList { __typename }`,
    {
      variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
      fetchPolicy: 'cache-and-network',
      skip: !listQuery || !ciType,
    },
  )

  const [createCI, { loading: creating }] = useMutation<Record<string, { id: string; name: string }>>(
    createMutation ?? gql`mutation EmptyCICreate { __typename }`,
    {
      onCompleted: (res) => {
        const key = `create${toPascalCase(typeName ?? '')}`
        const newId = res[key]?.id
        // «Business Application creato»: il genere del tipo non si sa, quello di «CI» sì.
        toast.success(t('pages.cmdb.ciCreated', { name: res[key]?.name ?? '', type: ciTypeLabel || typeName }))
        setShowCreate(false)
        void refetch()
        if (newId) navigate(`/ci/${typeName}/${newId}`)
      },
      onError: (err) => showError(err),
    },
  )

  const result = queryKey ? data?.[queryKey] : undefined
  const items = result?.items ?? []
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const filterFields = useMemo(
    () => (ciType ? ciFilterFields(ciType, t, baseEnums, labelOf) : []),
    [ciType, t, baseEnums, labelOf],
  )

  const COLUMNS: ColumnDef<CIItem>[] = [
    { key: 'name', label: t('pages.cmdb.name'), sortable: true },
    {
      key: 'environment', label: t('pages.cmdb.environment'), sortable: true,
      render: (v) => v ? <EnvBadge environment={v as string} /> : <span style={{ color: palette.neutral.borderStrong }}>—</span>,
    },
    {
      key: 'status', label: t('pages.cmdb.status'), sortable: true,
      render: (v) => v ? <StatusBadge value={v as string} /> : <span style={{ color: palette.neutral.borderStrong }}>—</span>,
    },
    {
      key: 'ownerGroup', label: t('pages.cmdb.ownerGroup'), sortable: true,
      render: (v) => (v as CIItem['ownerGroup'])?.name ?? <span style={{ color: palette.neutral.borderStrong }}>—</span>,
    },
    {
      key: 'createdAt', label: t('pages.cmdb.createdAt'), sortable: true,
      render: (v) => formatDate(v as string),
    },
  ]

  if (metamodelLoading) {
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
  }
  if (metamodelError) {
    return <div style={{ padding: 40 }}><QueryError message={metamodelError.message} /></div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>{t('pages.cmdb.notFound', { type: typeName })}</div>
  }


  return (
    <PageContainer>
      <ListPageHeader
        icon={<CIIcon icon={ciType.icon} size={22} color="var(--color-icon-accent)" />}
        title={ciTypeLabel}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.ci.count', { count: total })}
          </p>
        }
        actions={
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setShowCreate(true)}>
            {newLabel}
          </Button>
        }
      />

      {baseEnums.error && <QueryError message={`${t('pages.cmdb.baseEnumsUnavailable')}: ${baseEnums.error}`} />}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={filterFields}
            onApply={(group) => { setFilterGroup(group); setPage(0) }}
          />
        </div>
        <ExportCsvButton
          onExport={async () => {
            if (!listQuery || !queryKey) return
            const res = await apolloClient.query<Record<string, { total: number; items: CIItem[] }>>({
              query: listQuery,
              variables: { limit: 10000, offset: 0, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
              fetchPolicy: 'network-only',
            })
            exportToCsv(typeName ?? 'ci', COLUMNS, res.data?.[queryKey]?.items ?? [])
          }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
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

          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        </>
      )}

      {/* Create modal */}
      {showCreate && (
        <Modal open onClose={() => setShowCreate(false)} title={newLabel} width={520}>
          <CIDynamicForm
            ciType={ciType}
            loading={creating}
            onCancel={() => setShowCreate(false)}
            onSubmit={async (values) => {
              await createCI({ variables: { input: values } })
            }}
          />
        </Modal>
      )}
    </PageContainer>
  )
}
