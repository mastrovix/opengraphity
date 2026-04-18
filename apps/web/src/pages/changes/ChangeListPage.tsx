import { useState, useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { GitPullRequest } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { EmptyState } from '@/components/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { GET_CHANGES } from '@/graphql/queries'
import { lookupOrError } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

interface ChangeRow {
  id:                 string
  code:               string
  title:              string
  workflowInstance:   { id: string; currentStep: string; status: string } | null
  aggregateRiskScore: number | null
  approvalRoute:      string | null
  approvalStatus:     string | null
  createdAt:          string
  updatedAt:          string
  requester:          { id: string; name: string; email: string } | null
  changeOwner:        { id: string; name: string; email: string } | null
}

const PAGE_SIZE = 50

// Visual palette for a step bucket — keyed by the step's `category` metadata
// (admin-editable in the designer). If a tenant introduces a new category
// it falls back to the neutral slate style.
const CATEGORY_STYLE: Record<string, { bg: string; color: string }> = {
  active:    { bg: '#dbeafe', color: '#2563eb' },
  waiting:   { bg: '#ede9fe', color: '#7c3aed' },
  escalated: { bg: '#fed7aa', color: '#b45309' },
  resolved:  { bg: '#dcfce7', color: '#15803d' },
  closed:    { bg: 'var(--color-slate-bg)', color: 'var(--color-slate-light)' },
  failed:    { bg: '#fee2e2', color: '#b91c1c' },
  draft:     { bg: '#f1f5f9', color: 'var(--color-slate)' },
}
const NEUTRAL_STYLE = { bg: '#f1f5f9', color: 'var(--color-slate)' }

function PhaseBadge({ phase, label, category }: { phase: string; label?: string; category?: string | null }) {
  const style = lookupOrError(CATEGORY_STYLE, category ?? '__miss__', 'CATEGORY_STYLE', NEUTRAL_STYLE)
  return (
    <span style={{
      display:         'inline-block',
      padding:         '2px 8px',
      borderRadius:    6,
      fontSize:        'var(--font-size-label)',
      fontWeight:      600,
      backgroundColor: style.bg,
      color:           style.color,
      textTransform:   'capitalize',
    }}>
      {label || phase}
    </span>
  )
}

function RiskBadge({ score }: { score: number | null }) {
  if (score == null) {
    return <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)' }}>—</span>
  }
  const level = score <= 30 ? 'low' : score <= 60 ? 'medium' : 'high'
  const palette: Record<string, { bg: string; color: string; label: string }> = {
    low:    { bg: '#dcfce7', color: '#15803d', label: 'LOW'    },
    medium: { bg: '#fef3c7', color: '#b45309', label: 'MEDIUM' },
    high:   { bg: '#fee2e2', color: '#b91c1c', label: 'HIGH'   },
  }
  const p = lookupOrError(palette, level, 'RISK_PALETTE', palette['low']!)
  return (
    <span style={{
      display:         'inline-flex',
      alignItems:      'center',
      gap:             6,
      padding:         '2px 8px',
      borderRadius:    6,
      fontSize:        'var(--font-size-label)',
      fontWeight:      600,
      backgroundColor: p.bg,
      color:           p.color,
    }}>
      {p.label} · {score}
    </span>
  )
}

function extractStepFromFilter(group: FilterGroup | null): string | null {
  if (!group || group.rules.length === 0) return null
  const rule = group.rules.find(r => r.field === 'currentStep' && (r.operator === 'equals' || r.operator === 'in'))
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

  const { steps: wfSteps, byName: stepByName } = useWorkflowSteps('change')
  const filterFields: FieldConfig[] = [
    { key: 'currentStep', label: 'Step', type: 'enum',
      options: wfSteps.map((s) => ({ value: s.name, label: s.label || s.name })) },
  ]

  const { data, loading, refetch } = useQuery<{ changes: { items: ChangeRow[]; total: number } }>(GET_CHANGES, {
    variables: { currentStep, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
  })

  useEffect(() => {
    if ((location.state as { refresh?: boolean } | null)?.refresh) {
      void refetch()
    }
  }, [location.state]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = data?.changes?.items ?? []
  const total = data?.changes?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const columns: ColumnDef<ChangeRow>[] = [
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
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<GitPullRequest size={22} color="var(--color-brand)" />}>
            {t('pages.changes.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.changes.count', { count: total })}
          </p>
        </div>
        <button
          onClick={() => navigate('/changes/new')}
          style={{
            display:         'flex',
            alignItems:      'center',
            gap:             6,
            padding:         '8px 16px',
            backgroundColor: 'var(--color-brand)',
            color:           '#fff',
            border:          'none',
            borderRadius:    6,
            fontSize:        'var(--font-size-card-title)',
            fontWeight:      500,
            cursor:          'pointer',
            transition:      'background-color 150ms',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand-hover)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand)' }}
        >
          {t('pages.changes.new')}
        </button>
      </div>

      <FilterBuilder
        fields={filterFields}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

      <SortableFilterTable<ChangeRow>
        columns={columns}
        data={items}
        loading={loading}
        emptyComponent={<EmptyState icon={<GitPullRequest size={32} />} title={t('pages.changes.noResults')} description={t('pages.changes.noResultsDesc')} />}
        onRowClick={(row) => navigate(`/changes/${row.id}`)}
      />

      <Pagination
        currentPage={page + 1}
        totalPages={totalPages}
        onPrev={() => setPage(p => p - 1)}
        onNext={() => setPage(p => p + 1)}
      />
    </PageContainer>
  )
}
