import { useState, useEffect } from 'react'
import { useCustomFieldColumns, withCustomFieldCells } from '@/components/ticket/customFields/customFieldColumns'
import { useQuery } from '@apollo/client/react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { GitPullRequest, Plus } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { EmptyState } from '@/components/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { SeverityBadge, PhaseBadge, RiskBadge } from '@/components/ui/badges'
import { GET_CHANGES } from '@/graphql/queries'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { apolloClient } from '@/lib/apollo'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { formatDate } from '@/lib/datetime'

interface ChangeRow {
  customFields?: { name: string; value: string | null }[]
  id:                 string
  code:               string
  title:              string
  workflowInstance:   { id: string; currentStep: string; status: string } | null
  aggregateRiskScore: number | null
  priority:           string | null
  approvalRoute:      string | null
  approvalStatus:     string | null
  createdAt:          string
  updatedAt:          string
  requester:          { id: string; name: string; email: string } | null
  changeOwner:        { id: string; name: string; email: string } | null
}

const PAGE_SIZE = 50


function extractStepFromFilter(group: FilterGroup | null): string | null {
  if (!group || group.rules.length === 0) return null
  const rule = group.rules.find(r => r.field === 'currentStep' && (r.operator === 'equals' || r.operator === 'in'))
  if (!rule) return null
  if (typeof rule.value === 'string') return rule.value
  if (Array.isArray(rule.value) && rule.value.length > 0) return rule.value[0] ?? null
  return null
}

function extractFieldFromFilter(group: FilterGroup | null, field: string): string | null {
  if (!group || group.rules.length === 0) return null
  const rule = group.rules.find(r => r.field === field && (r.operator === 'equals' || r.operator === 'in'))
  if (!rule) return null
  if (typeof rule.value === 'string') return rule.value
  if (Array.isArray(rule.value) && rule.value.length > 0) return rule.value[0] ?? null
  return null
}

export function ChangeListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  const [page, setPage]             = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const currentStep = extractStepFromFilter(filterGroup)
  const priorityFilter = extractFieldFromFilter(filterGroup, 'priority')

  const { steps: wfSteps, byName: stepByName, labelFor } = useWorkflowSteps('change')
  // I valori del filtro sono quelli del CLIENTE (revisione totale · F-6): la
  // priorità era cablata a quattro valori con etichette inglesi letterali — un
  // cliente che aggiunge `emergency` non poteva filtrarla — e l'etichetta del
  // filtro sui passi era il letterale «Step» col nome tecnico del passo.
  const { valuesOf, labelOf } = useDomainVocabularies()
  const filterFields: FieldConfig[] = [
    { key: 'currentStep', label: t('pages.changes.phase'), type: 'enum',
      options: wfSteps.map((s) => ({ value: s.name, label: labelFor(s.name) ?? s.name })) },
    { key: 'priority', label: t('admin.sla.priority'), type: 'enum',
      // `valuesOf` è null finché i vocabolari non si conoscono: nessun valore
      // inventato, il filtro resta senza opzioni per un istante.
      options: (valuesOf('priority') ?? []).map((v) => ({ value: v, label: labelOf('priority', v) ?? v })) },
  ]

  // Ordinamento sul server: le colonne erano dichiarate ordinabili e il clic
  // non faceva nulla, perché `onSort` non arrivava alla tabella e la query non
  // aveva l'ordinamento (revisione totale · F-24). Ordinare solo la pagina
  // corrente sarebbe stato peggio: la lista è paginata dall'API.
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('desc')
  const handleSort = (field: string, dir: 'asc' | 'desc') => { setSortField(field); setSortDir(dir); setPage(0) }

  const { data, loading, error, refetch } = useQuery<{ changes: { items: ChangeRow[]; total: number } }>(GET_CHANGES, {
    variables: { currentStep, priority: priorityFilter, limit: PAGE_SIZE, offset: page * PAGE_SIZE, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
    pollInterval: 30_000,   // keep the list fresh without manual reload
  })

  useEffect(() => {
    if ((location.state as { refresh?: boolean } | null)?.refresh) {
      void refetch()
    }
  }, [location.state]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = data?.changes?.items ?? []
  const total = data?.changes?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // Campi del cliente (verifica «Cosa resta cablato», ondata 4): una colonna per campo.
  const customColumns = useCustomFieldColumns<ChangeRow>('change')
  const baseColumns: ColumnDef<ChangeRow>[] = [
    {
      key:      'code',
      label:    t('pages.changes.code'),
      width:    '140px',
      sortable: true,
      render:   (v) => (
        <span style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>
          {String(v ?? '')}
        </span>
      ),
    },
    { key: 'title', label: t('pages.changes.title_col'), sortable: true },
    {
      key:    'workflowInstance',
      label:  t('pages.changes.phase'),
      width:  '140px',
      render: (_, row) => {
        const step = row.workflowInstance?.currentStep ?? ''
        const meta = stepByName.get(step)
        return <PhaseBadge phase={step} label={meta?.label} category={meta?.category ?? null} />
      },
    },
    {
      key:    'requester',
      label:  t('pages.changes.requester'),
      width:  '180px',
      render: (_, row) => (
        <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          {row.requester?.name ?? '—'}
        </span>
      ),
    },
    {
      key:    'priority',
      label:  t('admin.sla.priority'),
      width:  '120px',
      // F-5: la priorità viene dal vocabolario `priority`.
      render: (v) => v ? <SeverityBadge value={v as string} vocabulary="priority" /> : <span style={{ color: 'var(--color-slate-light)' }}>—</span>,
    },
    {
      key:    'aggregateRiskScore',
      label:  t('pages.changes.risk'),
      width:  '140px',
      render: (v) => <RiskBadge score={v as number | null} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.changes.createdAt'),
      width:    '130px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: 'var(--color-slate-light)' }}>
          {formatDate(String(v))}
        </span>
      ),
    },
  ]
  const columns = [...baseColumns, ...customColumns]


  return (
    <PageContainer>
      <ListPageHeader
        icon={<GitPullRequest size={22} color="var(--color-icon-accent)" />}
        title={t('pages.changes.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.changes.count', { count: total })}
          </p>
        }
        actions={
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => navigate('/changes/new')}>
            {t('pages.changes.new')}
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
            const res = await apolloClient.query<{ changes: { items: ChangeRow[] } }>({
              query: GET_CHANGES,
              variables: { currentStep, limit: 10000, offset: 0 },
              fetchPolicy: 'network-only',
            })
            const rows = (res.data?.changes?.items ?? []).map((r) => ({
              code:      r.code,
              title:     r.title,
              phase:     stepByName.get(r.workflowInstance?.currentStep ?? '')?.label ?? r.workflowInstance?.currentStep ?? '',
              requester: r.requester?.name ?? '',
              risk:      r.aggregateRiskScore,
              createdAt: r.createdAt,
              ...Object.fromEntries((r.customFields ?? []).map((f) => [`cf:${f.name}`, f.value])),
            }))
            exportToCsv('changes', [
              { key: 'code',      label: t('pages.changes.code') },
              { key: 'title',     label: t('pages.changes.title_col') },
              { key: 'phase',     label: t('pages.changes.phase') },
              { key: 'requester', label: t('pages.changes.requester') },
              { key: 'risk',      label: t('pages.changes.risk') },
              { key: 'createdAt', label: t('pages.changes.createdAt') },
              ...customColumns.map((c) => ({ key: c.key as string, label: c.label })),
            ] as { key: keyof (typeof rows)[number]; label: string }[], rows)
          }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable<ChangeRow>
            columns={columns}
            data={withCustomFieldCells(items)}
            loading={loading}
            emptyComponent={<EmptyState icon={<GitPullRequest size={32} />} title={t('pages.changes.noResults')} description={t('pages.changes.noResultsDesc')} />}
            onRowClick={(row) => navigate(`/changes/${row.id}`)}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
          />

          <Pagination
            currentPage={page + 1}
            totalPages={totalPages}
            onPrev={() => setPage(p => p - 1)}
            onNext={() => setPage(p => p + 1)}
          />
        </>
      )}
    </PageContainer>
  )
}
